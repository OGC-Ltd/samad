// samad-server: the API behind the Samad Resources fleet dashboard.
//
// Reads the fleet from the IntelliFleet360 Partner API and serves it in the
// shapes the dashboard (a cut of new-ui) was built against: sign-in, the live
// map and its stream, tracks and replays, alerts, drivers and the fleet
// summary.
package main

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/mux"
	"golang.org/x/crypto/bcrypt"
)

func main() {
	// `samad-server hash-password <password>` prints an ADMIN_PASSWORD_HASH.
	if len(os.Args) == 3 && os.Args[1] == "hash-password" {
		h, err := bcrypt.GenerateFromPassword([]byte(os.Args[2]), bcrypt.DefaultCost)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(string(h))
		return
	}
	// `samad-server healthcheck` exits 0 when the API answers: the container
	// image has no shell or curl to do it with.
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		if !healthy() {
			os.Exit(1)
		}
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	hub := NewHub()
	store := NewStore(cfg.DataDir)
	client := NewPartnerClient(cfg.PartnerBaseURL, cfg.PartnerAPIKey)
	srv := &Server{cfg: cfg, client: client, store: store, hub: hub, ai: NewInsighter(cfg),
		routing: NewRouting(NewGoogle(cfg.GoogleKey()), store)}
	if srv.ai == nil {
		log.Printf("no OPENAI_API_KEY: the Fleet summary shows facts, not an AI brief")
	}
	if !srv.routing.enabled() {
		log.Printf("no GOOGLE_ROUTING_API_KEY: no road routes, arrivals or weather layer")
	}
	auth := NewAuth(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownTracing := setupTracing(ctx)
	obs.streams = hub.Count
	go obs.runSampler(ctx.Done(), cfg.DataDir)
	go (&Poller{cfg: cfg, client: client, store: store, hub: hub}).Run(ctx)

	httpSrv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           traceRequests(routes(srv, auth)),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("samad-server listening on :%s", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdown)
	_ = shutdownTracing(shutdown)
	store.Save()
}

// version is the release (1.0, 1.1, …), set at build time with
// -ldflags "-X main.version=…"; see the Dockerfile.
var version = "dev"

// healthy asks the running server's /health, for `samad-server healthcheck`.
func healthy() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+env("PORT", "8080")+"/api/v1/health", nil)
	if err != nil {
		return false
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == http.StatusOK
}

func routes(s *Server, a *Auth) http.Handler {
	r := mux.NewRouter()
	r.Use(logRequests, cors(s.cfg.AllowOrigin))

	// Prometheus scrapes this (system.go): served only with METRICS_TOKEN set.
	r.Handle("/metrics", prometheus(s, os.Getenv("METRICS_TOKEN"))).Methods("GET")

	api := r.PathPrefix("/api/v1").Subrouter()
	api.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeData(w, map[string]any{"ok": true, "version": version})
	}).Methods("GET")
	api.HandleFunc("/auth/login", a.Login).Methods("POST")
	api.HandleFunc("/auth/refresh", a.Refresh).Methods("POST")
	api.HandleFunc("/auth/logout", a.Logout).Methods("POST")

	// Set-password links work signed out.
	api.HandleFunc("/account/setup/{token}", a.inspectSetup).Methods("GET")
	api.HandleFunc("/account/setup", a.completeSetup).Methods("POST")
	api.HandleFunc("/account/forgot-password", a.forgotPassword).Methods("POST")

	in := api.NewRoute().Subrouter()
	in.Use(a.Require)
	in.HandleFunc("/auth/me", a.Me).Methods("GET")
	in.HandleFunc("/bootstrap", s.bootstrap).Methods("GET")
	in.HandleFunc("/account/profile", a.profile).Methods("GET")
	in.HandleFunc("/account/profile", a.updateProfile).Methods("PATCH")
	in.HandleFunc("/account/password", a.changePassword).Methods("PATCH")
	in.HandleFunc("/account/sessions/revoke-all", a.revokeAllSessions).Methods("POST")
	in.HandleFunc("/account/tour", a.recordTour).Methods("POST")

	// Each screen's routes need the permission the screen is drawn for
	// (roles.go); the dashboard hides what a role lacks, this refuses it.
	alerts := []string{"alerts:read", "fuel_theft:read", "analytics:read"}
	in.Handle("/alerts", needFunc(s.listAlerts, alerts...)).Methods("GET")
	in.Handle("/alerts/summary", needFunc(s.alertSummary, alerts...)).Methods("GET")
	in.Handle("/alerts/history", needFunc(s.alertHistory, alerts...)).Methods("GET")
	in.Handle("/alerts/read", needFunc(s.markRead, alerts...)).Methods("POST")
	in.Handle("/alerts/read-all", needFunc(s.markAllRead, alerts...)).Methods("POST")

	in.Handle("/vss/cameras", needFunc(s.vssCameras, "telemetry:read")).Methods("GET")
	in.Handle("/vss/alarms", needFunc(s.vssAlarms, "telemetry:read")).Methods("GET")
	in.Handle("/vss/file", needFunc(s.vssFile, "telemetry:read")).Methods("GET")

	org := in.PathPrefix("/organisations/{org}").Subrouter()
	org.Use(ourOrg)
	org.Handle("/vehicles/snapshot", needFunc(s.snapshot, "telemetry:read")).Methods("GET")
	org.Handle("/live", unitsVisible(needFunc(s.live, "notification:read", "telemetry:read"))).Methods("GET")
	org.Handle("/vehicles/{vehicleId}/camera", unitsVisible(needFunc(s.vehicleCamera, "telemetry:read"))).Methods("GET")
	org.Handle("/vehicles/{vehicleId}/track", unitsVisible(needFunc(s.track, "map:read", "map:playback"))).Methods("GET")
	org.Handle("/vehicles/{vehicleId}/playback", unitsVisible(needFunc(s.playback, "map:playback"))).Methods("GET")
	org.Handle("/geofences/geojson", needFunc(s.geofencesGeoJSON, "geofence:read", "map:read")).Methods("GET")
	org.Handle("/analytics/drivers/overview", needFunc(s.driversOverview, "driver:read")).Methods("GET")
	org.Handle("/dashboard/ai-insight", needFunc(s.fleetInsight, "dashboard:read")).Methods("GET")
	org.Handle("/incidents/{kind:speeding|camera}/{id}/review", needFunc(s.reviewAlert, alerts...)).Methods("POST")

	// Weather and routing (routing.go).
	rt := s.routing
	org.Handle("/routing/status", needFunc(rt.status, "vehicle:read")).Methods("GET")
	org.Handle("/routing/hubs", needFunc(rt.listHubs, "vehicle:read")).Methods("GET")
	org.Handle("/routing/hubs/{hubKey}/inbound", unitsVisible(needFunc(rt.inbound, "vehicle:read"))).Methods("GET")
	org.Handle("/routing/point/inbound", unitsVisible(needFunc(rt.inboundAt, "vehicle:read"))).Methods("GET")
	org.Handle("/weather/grid", needFunc(rt.weatherGrid, "vehicle:read")).Methods("GET")
	org.Handle("/vehicles/{vehicleId}/route-ahead", unitsVisible(needFunc(rt.routeAhead(s), "vehicle:read"))).Methods("GET")

	users := org.PathPrefix("/users").Subrouter()
	users.Handle("", needFunc(a.listUsers, "user:read")).Methods("GET")
	users.Handle("/assignable-roles", needFunc(a.assignableRoles, "user:assign_role")).Methods("GET")
	users.Handle("/provision", needFunc(a.provision, "user:create")).Methods("POST")
	users.Handle("/{userId}", needFunc(a.getUser, "user:read")).Methods("GET")
	users.Handle("/{userId}", needFunc(a.updateUser, "user:update")).Methods("PATCH")
	users.Handle("/{userId}/resend-invite", needFunc(a.resendInvite, "user:create")).Methods("POST")
	users.Handle("/{userId}/status", needFunc(a.setStatus, "user:update")).Methods("PATCH")
	users.Handle("/{userId}/role", needFunc(a.setRole, "user:assign_role")).Methods("PATCH")
	users.Handle("/{userId}/memberships", needFunc(a.listMemberships, "user:read")).Methods("GET")
	users.Handle("/{userId}/memberships", needFunc(a.setRole, "user:assign_role")).Methods("PUT")
	users.Handle("/{userId}/memberships", needFunc(a.removeMembership, "user:assign_role")).Methods("DELETE")
	users.Handle("/{userId}/permanent", needFunc(a.purge, "user:delete")).Methods("DELETE")

	groups := org.PathPrefix("/user-groups").Subrouter()
	groups.Handle("", needFunc(a.listGroups, "user:read")).Methods("GET")
	groups.Handle("", needFunc(a.createGroup, "user:assign_role")).Methods("POST")
	groups.Handle("/{groupId}", needFunc(a.updateGroup, "user:assign_role")).Methods("PATCH")
	groups.Handle("/{groupId}", needFunc(a.deleteGroup, "user:assign_role")).Methods("DELETE")
	groups.Handle("/{groupId}/users/{userId}", needFunc(a.setGroupMember, "user:assign_role")).Methods("PUT", "DELETE")
	groups.Handle("/{groupId}/logo", needFunc(a.setGroupLogo, "user:assign_role")).Methods("PUT", "DELETE")
	groups.HandleFunc("/{groupId}/logo", a.groupLogo).Methods("GET")

	// Everything else the UI may ask for, signed in: an empty answer.
	in.PathPrefix("/").HandlerFunc(emptyRoute)

	// The built dashboard, when STATIC_DIR points at it (one-box deploy).
	if dir := os.Getenv("STATIC_DIR"); dir != "" {
		h, err := spa(dir)
		if err != nil {
			log.Fatalf("STATIC_DIR: %v", err)
		}
		r.PathPrefix("/").Handler(h)
	}
	return r
}

// ourOrg refuses any organisation but Samad's.
func ourOrg(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if mux.Vars(r)["org"] != OrgID {
			writeError(w, http.StatusNotFound, "no such organisation")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// spa serves files from dir, and index.html for any other page path. A
// missing file (anything with an extension, under /api, or in a hidden
// folder like /.git) is a 404, not the
// app: scanners asking for /secrets.json or /.env get nothing that looks
// like a hit.
//
// Files are read through an os.Root: no path, symlink or ".." can reach
// outside dir.
func spa(dir string) (http.Handler, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	fsys := root.FS()
	files := http.FileServerFS(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := path.Clean("/" + r.URL.Path)
		if st, err := fs.Stat(fsys, strings.TrimPrefix(clean, "/")); err != nil || st.IsDir() {
			if path.Ext(clean) != "" || strings.HasPrefix(clean, "/api/") || strings.Contains(clean, "/.") {
				http.NotFound(w, r)
				return
			}
			http.ServeFileFS(w, r, fsys, "index.html")
			return
		}
		files.ServeHTTP(w, r)
	}), nil
}

func cors(origin string) mux.MiddlewareFunc {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if origin != "" && r.Header.Get("Origin") == origin {
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Access-Control-Allow-Credentials", "true")
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				if r.Method == http.MethodOptions {
					w.WriteHeader(http.StatusNoContent)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		route := routeLabel(r)
		traceID := nameSpan(r, route)
		obs.begin()
		sw := &obsWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		stream := strings.HasPrefix(sw.Header().Get("Content-Type"), "text/event-stream")
		obs.done(r.Method, route, sw.status, sw.bytes, time.Since(start), stream)
		// trace=: Grafana links a log line to its trace in Jaeger by this field
		// (deploy/observability). A 32-character hex id, nothing to quote.
		tail := ""
		if traceID != "" {
			tail = " trace=" + traceID
		}
		// %q: a path with an encoded newline cannot forge a log line.
		log.Printf("%q %q %d %s%s", r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Millisecond), tail) //nolint:gosec // G706: both values are quoted
	})
}
