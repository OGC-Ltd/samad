package main

// Sign-in. One account, from the environment (ADMIN_EMAIL and a bcrypt
// ADMIN_PASSWORD_HASH; `go run . hash-password` prints one).
//
// Same flow as fleet-server, so the UI is unchanged: POST /auth/login answers
// a short-lived access token and sets a refresh cookie; POST /auth/refresh
// trades the cookie for a new access token after a reload. Tokens are
// HMAC-SHA256 signed with JWT_SECRET.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	accessTTL     = 15 * time.Minute
	refreshTTL    = 7 * 24 * time.Hour
	refreshCookie = "samad_rt"
)

type tokenClaims struct {
	Sub string `json:"sub"`
	Typ string `json:"typ"`
	Exp int64  `json:"exp"`
}

type Auth struct {
	cfg    Config
	secret []byte
}

func NewAuth(cfg Config) *Auth { return &Auth{cfg: cfg, secret: []byte(cfg.JWTSecret)} }

func (a *Auth) sign(c tokenClaims) string {
	body, _ := json.Marshal(c)
	payload := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *Auth) verify(token, typ string) (tokenClaims, error) {
	var c tokenClaims
	payload, sig, ok := strings.Cut(token, ".")
	if !ok {
		return c, errors.New("malformed token")
	}
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte(payload))
	want := mac.Sum(nil)
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(got, want) {
		return c, errors.New("bad signature")
	}
	body, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil || json.Unmarshal(body, &c) != nil {
		return c, errors.New("malformed token")
	}
	if c.Typ != typ || time.Now().Unix() > c.Exp {
		return c, errors.New("expired token")
	}
	return c, nil
}

func (a *Auth) issue(w http.ResponseWriter, r *http.Request, email string) string {
	now := time.Now()
	// Secure follows the request: always on behind Traefik (HTTPS), off for
	// the plain-HTTP dev server, where a Secure cookie would never be sent.
	http.SetCookie(w, &http.Cookie{ //nolint:gosec // G124: Secure is isHTTPS(r), see above
		Name:     refreshCookie,
		Value:    a.sign(tokenClaims{Sub: email, Typ: "refresh", Exp: now.Add(refreshTTL).Unix()}),
		Path:     "/api/v1",
		Expires:  now.Add(refreshTTL),
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
	return a.sign(tokenClaims{Sub: email, Typ: "access", Exp: now.Add(accessTTL).Unix()})
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

func (a *Auth) Login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	// Compare the password even for an unknown email, so the two cannot be
	// told apart by timing.
	hashErr := bcrypt.CompareHashAndPassword([]byte(a.cfg.AdminPasswordHash), []byte(body.Password))
	if email != a.cfg.AdminEmail || hashErr != nil {
		writeError(w, http.StatusUnauthorized, "Invalid email or password")
		return
	}
	writeData(w, map[string]any{"accessToken": a.issue(w, r, email)})
}

func (a *Auth) Refresh(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(refreshCookie)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "no session")
		return
	}
	claims, err := a.verify(c.Value, "refresh")
	if err != nil || claims.Sub != a.cfg.AdminEmail {
		writeError(w, http.StatusUnauthorized, "session expired")
		return
	}
	writeData(w, map[string]any{"accessToken": a.issue(w, r, claims.Sub)})
}

func (a *Auth) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{ //nolint:gosec // G124: Secure is isHTTPS(r), as in issue
		Name: refreshCookie, Value: "", Path: "/api/v1", MaxAge: -1,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	writeData(w, map[string]any{"ok": true})
}

// The screens this account opens, as the UI's permission slugs.
var permissions = []string{
	"map:read", "map:playback", "telemetry:read", "dashboard:read",
	"alerts:read", "driver:read",
}

func (a *Auth) Me(w http.ResponseWriter, r *http.Request) {
	email := userOf(r.Context())
	writeData(w, map[string]any{
		"user": map[string]any{
			"id": email, "email": email, "fullName": a.cfg.AdminName, "name": a.cfg.AdminName,
		},
		"isPlatform": false,
		"organisations": []any{map[string]any{
			"id": OrgID, "code": OrgCode, "name": OrgName,
			"permissions": permissions, "vehicleIds": nil,
		}},
	})
}

type ctxKey struct{}

func userOf(ctx context.Context) string {
	s, _ := ctx.Value(ctxKey{}).(string)
	return s
}

// Require accepts a Bearer access token, or the refresh cookie: EventSource
// cannot send headers, and the live stream is same-origin, so it rides on
// the cookie.
func (a *Auth) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var email string
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			if c, err := a.verify(strings.TrimPrefix(h, "Bearer "), "access"); err == nil {
				email = c.Sub
			}
		} else if ck, err := r.Cookie(refreshCookie); err == nil {
			if c, err := a.verify(ck.Value, "refresh"); err == nil {
				email = c.Sub
			}
		}
		if email == "" || email != a.cfg.AdminEmail {
			writeError(w, http.StatusUnauthorized, "unauthorised")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, email)))
	})
}
