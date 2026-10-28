package main

// End-to-end tests of the routes the dashboard relies on, through the same
// router main() builds: sign-in, the static app, organisation scoping and
// the Camera page's alarms and clip proxy.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	testEmail    = "admin@samad.test"
	testPassword = "correct horse battery staple"
)

type harness struct {
	t     *testing.T
	h     http.Handler
	store *Store
	cfg   Config
	auth  *Auth
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	// Not t.TempDir: the server holds the folder open (os.Root) for its
	// whole life, and Windows will not delete an open folder.
	web, err := os.MkdirTemp("", "samad-web-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(web) })
	mustWrite(t, filepath.Join(web, "index.html"), "<!doctype html><title>Samad</title>")
	mustWrite(t, filepath.Join(web, "app.js"), "console.log(1)")
	t.Setenv("STATIC_DIR", web)
	// The uploaded-file store holds DATA_DIR/files open (os.Root) too.
	data, err := os.MkdirTemp("", "samad-data-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(data) })

	cfg := Config{
		Port: "8080", JWTSecret: "test-secret-test-secret-test-secret",
		AdminEmail: testEmail, AdminName: "Test", AdminPasswordHash: string(hash),
		DataDir: data,
	}
	store := NewStore(cfg.DataDir)
	srv := &Server{cfg: cfg, store: store, hub: NewHub(), routing: NewRouting(nil, store)}
	auth := NewAuth(cfg)
	return &harness{t: t, h: routes(srv, auth), store: store, cfg: cfg, auth: auth}
}

func mustWrite(t *testing.T, p, s string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) do(method, target, token string, body any, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, target, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	h.h.ServeHTTP(rec, req)
	return rec
}

// login signs in and returns the access token and the refresh cookie.
func (h *harness) login() (string, *http.Cookie) {
	h.t.Helper()
	rec := h.do("POST", "/api/v1/auth/login", "", map[string]string{"email": testEmail, "password": testPassword})
	if rec.Code != http.StatusOK {
		h.t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	var out struct {
		Data struct {
			AccessToken string `json:"accessToken"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Data.AccessToken == "" {
		h.t.Fatalf("login body: %s", rec.Body)
	}
	var rt *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == refreshCookie {
			rt = c
		}
	}
	if rt == nil {
		h.t.Fatal("no refresh cookie")
	}
	return out.Data.AccessToken, rt
}

func TestLogin(t *testing.T) {
	h := newHarness(t)

	for _, tc := range []struct{ name, email, password string }{
		{"wrong password", testEmail, "nope"},
		{"unknown email", "someone@else.test", testPassword},
		{"empty", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.do("POST", "/api/v1/auth/login", "", map[string]string{"email": tc.email, "password": tc.password})
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("got %d, want 401", rec.Code)
			}
			if len(rec.Result().Cookies()) != 0 {
				t.Fatal("a failed sign-in set a cookie")
			}
		})
	}

	t.Run("email is case-insensitive", func(t *testing.T) {
		rec := h.do("POST", "/api/v1/auth/login", "", map[string]string{"email": "  Admin@Samad.TEST ", "password": testPassword})
		if rec.Code != http.StatusOK {
			t.Fatalf("got %d", rec.Code)
		}
	})

	t.Run("refresh cookie is HttpOnly, Lax, scoped to the API", func(t *testing.T) {
		_, rt := h.login()
		if !rt.HttpOnly || rt.SameSite != http.SameSiteLaxMode || rt.Path != "/api/v1" {
			t.Fatalf("cookie %+v", rt)
		}
	})

	t.Run("cookie is Secure behind HTTPS", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
			strings.NewReader(`{"email":"`+testEmail+`","password":"`+testPassword+`"}`))
		req.Header.Set("X-Forwarded-Proto", "https")
		rec := httptest.NewRecorder()
		h.h.ServeHTTP(rec, req)
		for _, c := range rec.Result().Cookies() {
			if c.Name == refreshCookie && !c.Secure {
				t.Fatal("refresh cookie not Secure over HTTPS")
			}
		}
	})
}

func TestTokens(t *testing.T) {
	h := newHarness(t)
	token, rt := h.login()

	if rec := h.do("GET", "/api/v1/auth/me", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := h.do("GET", "/api/v1/auth/me", token, nil); rec.Code != http.StatusOK {
		t.Fatalf("access token: %d", rec.Code)
	}
	if rec := h.do("GET", "/api/v1/auth/me", token+"x", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("tampered token: %d", rec.Code)
	}
	// A refresh token is not an access token.
	if rec := h.do("GET", "/api/v1/auth/me", rt.Value, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("refresh token as bearer: %d", rec.Code)
	}
	if rec := h.do("POST", "/api/v1/auth/refresh", "", nil, rt); rec.Code != http.StatusOK {
		t.Fatalf("refresh: %d", rec.Code)
	}

	// The real account and session, so only the one thing named is wrong.
	me, _ := h.auth.users.GetByEmail(testEmail)
	claims := tokenClaims{Sub: me.ID, Ver: me.SessionVersion, Typ: "access", Exp: time.Now().Add(time.Hour).Unix()}
	if rec := h.do("GET", "/api/v1/auth/me", h.auth.sign(claims), nil); rec.Code != http.StatusOK {
		t.Fatalf("well-formed token: %d", rec.Code)
	}

	t.Run("expired token", func(t *testing.T) {
		old := claims
		old.Exp = time.Now().Add(-time.Minute).Unix()
		if rec := h.do("GET", "/api/v1/auth/me", h.auth.sign(old), nil); rec.Code != http.StatusUnauthorized {
			t.Fatalf("expired: %d", rec.Code)
		}
	})

	t.Run("signed with another secret", func(t *testing.T) {
		a := NewAuth(Config{JWTSecret: "some-other-secret", AdminEmail: testEmail, DataDir: t.TempDir()})
		if rec := h.do("GET", "/api/v1/auth/me", a.sign(claims), nil); rec.Code != http.StatusUnauthorized {
			t.Fatalf("forged: %d", rec.Code)
		}
	})

	t.Run("ended session", func(t *testing.T) {
		stale := claims
		stale.Ver--
		if rec := h.do("GET", "/api/v1/auth/me", h.auth.sign(stale), nil); rec.Code != http.StatusUnauthorized {
			t.Fatalf("token from an ended session: %d", rec.Code)
		}
	})
}

func TestStaticApp(t *testing.T) {
	h := newHarness(t)
	for _, tc := range []struct {
		path string
		code int
		has  string
	}{
		{"/", 200, "<title>Samad</title>"},
		{"/drivers", 200, "<title>Samad</title>"}, // an app page: index.html
		{"/app.js", 200, "console.log"},
		{"/secrets.json", 404, ""},
		{"/.env", 404, ""},
		{"/.git/config", 404, ""},
		{"/api/other", 404, ""},
	} {
		t.Run(tc.path, func(t *testing.T) {
			rec := h.do("GET", tc.path, "", nil)
			if rec.Code != tc.code {
				t.Fatalf("got %d, want %d", rec.Code, tc.code)
			}
			if tc.has != "" && !strings.Contains(rec.Body.String(), tc.has) {
				t.Fatalf("body %q", rec.Body)
			}
		})
	}
}

// Nothing outside STATIC_DIR is ever served, however the path is spelled.
// (The router may answer a redirect to the cleaned path instead.)
func TestStaticTraversal(t *testing.T) {
	h := newHarness(t)
	outside := filepath.Join(filepath.Dir(os.Getenv("STATIC_DIR")), "samad-outside.txt")
	mustWrite(t, outside, "TOP SECRET")
	t.Cleanup(func() { _ = os.Remove(outside) })
	for _, p := range []string{
		"/../samad-outside.txt", "/%2e%2e/samad-outside.txt", "/..%2fsamad-outside.txt",
		"/app.js/../../samad-outside.txt", "/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd",
	} {
		rec := h.do("GET", p, "", nil)
		if strings.Contains(rec.Body.String(), "TOP SECRET") || strings.Contains(rec.Body.String(), "root:") {
			t.Errorf("%s served a file outside STATIC_DIR (%d)", p, rec.Code)
		}
	}
}

func TestOrganisationScope(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	for _, path := range []string{
		"/api/v1/organisations/other/vehicles/snapshot",
		"/api/v1/vss/alarms?org=other",
		"/api/v1/vss/cameras?org=other",
		"/api/v1/vss/file?org=other&k=x.road",
	} {
		if rec := h.do("GET", path, token, nil); rec.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", path, rec.Code)
		}
	}
	for _, path := range []string{"/api/v1/vss/alarms?org=samad", "/api/v1/vss/file?org=samad&k=x.road", "/api/v1/alerts"} {
		if rec := h.do("GET", path, "", nil); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s signed out: got %d, want 401", path, rec.Code)
		}
	}
}

func cameraEvent(id, typ string, at time.Time, road string) PEvent {
	e := PEvent{
		EventID: id, Source: "device", Type: typ, Severity: "critical",
		OccurredAt: at.UTC().Format(time.RFC3339), ReceivedAt: at.UTC().Format(time.RFC3339),
		VehicleID: 402, Registration: "KDU566F",
	}
	e.Clips = &struct {
		RoadFacing   *string `json:"road_facing"`
		DriverFacing *string `json:"driver_facing"`
	}{RoadFacing: &road}
	return e
}

func TestCameraAlarms(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	now := time.Now()
	h.store.AddEvents([]PEvent{
		cameraEvent("a", "no_seatbelt", now.Add(-2*time.Hour), "https://video.test/a.mp4"),
		cameraEvent("b", "lane_departure", now.Add(-time.Hour), "https://video.test/b.mp4"),
		cameraEvent("c", "something_new", now.Add(-30*time.Minute), "https://video.test/c.mp4"),
		cameraEvent("old", "phone_use", now.Add(-72*time.Hour), "https://video.test/old.mp4"),
		{EventID: "noclip", Source: "device", Type: "phone_use", Severity: "critical", OccurredAt: now.UTC().Format(time.RFC3339)},
	}, "")

	since := now.Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	rec := h.do("GET", "/api/v1/vss/alarms?org=samad&since="+since, token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("alarms: %d %s", rec.Code, rec.Body)
	}
	var out struct {
		Data struct {
			Incidents []struct {
				ID       string `json:"id"`
				Category string `json:"category"`
				Videos   []struct {
					URL string `json:"url"`
				} `json:"videos"`
			} `json:"incidents"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	got := out.Data.Incidents
	if len(got) != 3 {
		t.Fatalf("want 3 alarms in the window with a clip, got %d", len(got))
	}
	want := []struct{ id, cat string }{{"c", "other"}, {"b", "lane"}, {"a", "driver"}} // newest first
	for i, w := range want {
		if got[i].ID != w.id || got[i].Category != w.cat {
			t.Errorf("row %d: got %s/%s, want %s/%s", i, got[i].ID, got[i].Category, w.id, w.cat)
		}
		// Only our own file route reaches the browser, never the video host.
		for _, v := range got[i].Videos {
			if !strings.HasPrefix(v.URL, "/api/v1/vss/file?") {
				t.Errorf("row %d leaks %q", i, v.URL)
			}
		}
	}
}

func TestClipProxy(t *testing.T) {
	clip := bytes.Repeat([]byte("0123456789"), 100)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/clip.mp4" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		http.ServeContent(w, r, "clip.mp4", time.Time{}, bytes.NewReader(clip))
	}))
	defer upstream.Close()

	h := newHarness(t)
	token, rt := h.login()
	h.store.AddEvents([]PEvent{
		cameraEvent("ok", "phone_use", time.Now(), upstream.URL+"/clip.mp4"),
		cameraEvent("gone", "phone_use", time.Now(), upstream.URL+"/missing.mp4"),
	}, "")

	t.Run("range request passes through", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/vss/file?org=samad&k=ok.road", nil)
		req.Header.Set("Range", "bytes=10-19")
		req.AddCookie(rt) // a <video> sends the cookie, not the token
		rec := httptest.NewRecorder()
		h.h.ServeHTTP(rec, req)
		if rec.Code != http.StatusPartialContent || rec.Body.String() != "0123456789" {
			t.Fatalf("got %d %q", rec.Code, rec.Body)
		}
		if rec.Header().Get("Content-Range") != "bytes 10-19/1000" {
			t.Fatalf("content-range %q", rec.Header().Get("Content-Range"))
		}
	})

	t.Run("download names the file", func(t *testing.T) {
		rec := h.do("GET", "/api/v1/vss/file?org=samad&k=ok.road&download=1", token, nil)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Content-Disposition"), `filename="clip.mp4"`) {
			t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Content-Disposition"))
		}
	})

	for _, k := range []string{"gone.road", "ok.driver", "ok.other", "unknown.road", "nodot"} {
		t.Run("missing "+k, func(t *testing.T) {
			if rec := h.do("GET", "/api/v1/vss/file?org=samad&k="+k, token, nil); rec.Code != http.StatusNotFound {
				t.Fatalf("got %d, want 404", rec.Code)
			}
		})
	}
}

func TestAlertKind(t *testing.T) {
	for _, tc := range []struct {
		e    PEvent
		want string
	}{
		{PEvent{Type: "over_speeding", Source: "platform"}, kindSpeeding},
		{PEvent{Type: "geofence_speeding"}, kindSpeeding},
		{PEvent{Type: "no_seatbelt", Source: "device", Severity: "critical"}, kindCamera},
		{PEvent{Type: "lane_departure", Source: "device", Severity: "warning"}, kindCamera},
		{PEvent{Type: "road_facing_camera_occlusion", Source: "device", Severity: "informational"}, ""},
		{PEvent{Type: "geofence_entry", Source: "platform", Severity: "informational"}, ""},
	} {
		if got := alertKind(tc.e); got != tc.want {
			t.Errorf("%s/%s: got %q, want %q", tc.e.Type, tc.e.Severity, got, tc.want)
		}
	}
}
