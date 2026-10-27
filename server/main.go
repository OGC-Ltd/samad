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
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
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

	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	hub := NewHub()
	store := NewStore(cfg.DataDir)
	client := NewPartnerClient(cfg.PartnerBaseURL, cfg.PartnerAPIKey)
	srv := &Server{cfg: cfg, client: client, store: store, hub: hub}
	auth := NewAuth(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go (&Poller{cfg: cfg, client: client, store: store, hub: hub}).Run(ctx)

	httpSrv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           routes(srv, auth),
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
	store.Save()
}

func routes(s *Server, a *Auth) http.Handler {
	r := mux.NewRouter()
	r.Use(logRequests, cors(s.cfg.AllowOrigin))

	api := r.PathPrefix("/api/v1").Subrouter()
	api.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { writeData(w, map[string]any{"ok": true}) }).Methods("GET")
	api.HandleFunc("/auth/login", a.Login).Methods("POST")
	api.HandleFunc("/auth/refresh", a.Refresh).Methods("POST")
	api.HandleFunc("/auth/logout", a.Logout).Methods("POST")

	in := api.NewRoute().Subrouter()
	in.Use(a.Require)
	in.HandleFunc("/auth/me", a.Me).Methods("GET")
	in.HandleFunc("/bootstrap", s.bootstrap).Methods("GET")

	in.HandleFunc("/alerts", s.listAlerts).Methods("GET")
	in.HandleFunc("/alerts/summary", s.alertSummary).Methods("GET")
	in.HandleFunc("/alerts/history", s.alertHistory).Methods("GET")
	in.HandleFunc("/alerts/read", s.markRead).Methods("POST")
	in.HandleFunc("/alerts/read-all", s.markAllRead).Methods("POST")

	org := in.PathPrefix("/organisations/{org}").Subrouter()
	org.Use(ourOrg)
	org.HandleFunc("/vehicles/snapshot", s.snapshot).Methods("GET")
	org.HandleFunc("/live", s.live).Methods("GET")
	org.HandleFunc("/vehicles/{vehicleId}/track", s.track).Methods("GET")
	org.HandleFunc("/vehicles/{vehicleId}/playback", s.playback).Methods("GET")
	org.HandleFunc("/geofences/geojson", s.geofencesGeoJSON).Methods("GET")
	org.HandleFunc("/analytics/drivers/overview", s.driversOverview).Methods("GET")
	org.HandleFunc("/dashboard/ai-insight", s.fleetInsight).Methods("GET")
	org.HandleFunc("/incidents/{kind:speeding|camera}/{id}/review", s.reviewAlert).Methods("POST")

	// Everything else the UI may ask for, signed in: an empty answer.
	in.PathPrefix("/").HandlerFunc(emptyRoute)

	// The built dashboard, when STATIC_DIR points at it (one-box deploy).
	if dir := os.Getenv("STATIC_DIR"); dir != "" {
		r.PathPrefix("/").Handler(spa(dir))
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

// spa serves files from dir, and index.html for any path that is not one.
func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.FromSlash(filepath.Clean("/"+r.URL.Path)))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
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

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(s int) { w.status = s; w.ResponseWriter.WriteHeader(s) }

// Flush keeps the live stream working through the logging wrapper.
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Millisecond))
	})
}
