package main

// Sign-in, sessions and permission checks. Accounts and their roles live in
// users.go and roles.go; the account in server/.env (ADMIN_EMAIL and a bcrypt
// ADMIN_PASSWORD_HASH; `go run . hash-password` prints one) is the default
// super admin.
//
// Same flow as fleet-server, so the UI is unchanged: POST /auth/login answers
// a short-lived access token and sets a refresh cookie; POST /auth/refresh
// trades the cookie for a new access token after a reload. Tokens are
// HMAC-SHA256 signed with JWT_SECRET and name the account and its session
// version, so suspending someone or changing a password ends their sessions.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
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
	Sub string `json:"sub"` // the account's id
	Ver int    `json:"ver"` // its SessionVersion when issued
	Typ string `json:"typ"`
	Exp int64  `json:"exp"`
}

type Auth struct {
	cfg    Config
	secret []byte
	users  *Users
	groups *Groups
	// Compared against for an unknown address, so the two cannot be told
	// apart by timing.
	dummyHash []byte
}

func NewAuth(cfg Config) *Auth {
	users := NewUsers(cfg.DataDir)
	users.Bootstrap(cfg.AdminEmail, cfg.AdminName, cfg.AdminPasswordHash)
	dummy, _ := bcrypt.GenerateFromPassword([]byte("not a password anyone has"), bcrypt.DefaultCost)
	blobs, err := NewBlobs(cfg)
	if err != nil {
		log.Fatal(err)
	}
	return &Auth{cfg: cfg, secret: []byte(cfg.JWTSecret), users: users, groups: NewGroups(cfg.DataDir, blobs), dummyHash: dummy}
}

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

// session resolves a token to a live account: one that still exists, is
// active, and has not had its sessions ended since the token was issued.
func (a *Auth) session(token, typ string) (User, bool) {
	c, err := a.verify(token, typ)
	if err != nil {
		return User{}, false
	}
	u, ok := a.users.Get(c.Sub)
	if !ok || u.Status != statusActive || u.SessionVersion != c.Ver || u.PasswordHash == "" {
		return User{}, false
	}
	return u, true
}

func (a *Auth) issue(w http.ResponseWriter, r *http.Request, u User) string {
	now := time.Now()
	// Secure follows the request: always on behind Traefik (HTTPS), off for
	// the plain-HTTP dev server, where a Secure cookie would never be sent.
	http.SetCookie(w, &http.Cookie{ //nolint:gosec // G124: Secure is isHTTPS(r), see above
		Name:     refreshCookie,
		Value:    a.sign(tokenClaims{Sub: u.ID, Ver: u.SessionVersion, Typ: "refresh", Exp: now.Add(refreshTTL).Unix()}),
		Path:     "/api/v1",
		Expires:  now.Add(refreshTTL),
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
	return a.sign(tokenClaims{Sub: u.ID, Ver: u.SessionVersion, Typ: "access", Exp: now.Add(accessTTL).Unix()})
}

func clearSession(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{ //nolint:gosec // G124: Secure is isHTTPS(r), as in issue
		Name: refreshCookie, Value: "", Path: "/api/v1", MaxAge: -1,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
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
	u, found := a.users.GetByEmail(strings.TrimSpace(body.Email))
	hash := a.dummyHash
	if found && u.PasswordHash != "" {
		hash = []byte(u.PasswordHash)
	}
	hashErr := bcrypt.CompareHashAndPassword(hash, []byte(body.Password))
	if !found || u.PasswordHash == "" || hashErr != nil {
		writeError(w, http.StatusUnauthorized, "Invalid email or password")
		return
	}
	if u.Status != statusActive {
		writeError(w, http.StatusForbidden, "This account is suspended")
		return
	}
	u, _ = a.users.Update(u.ID, func(u *User) error {
		now := time.Now().UTC()
		u.LastLoginAt = &now
		return nil
	})
	writeData(w, map[string]any{"accessToken": a.issue(w, r, u)})
}

func (a *Auth) Refresh(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(refreshCookie)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "no session")
		return
	}
	u, ok := a.session(c.Value, "refresh")
	if !ok {
		clearSession(w, r)
		writeError(w, http.StatusUnauthorized, "session expired")
		return
	}
	writeData(w, map[string]any{"accessToken": a.issue(w, r, u)})
}

func (a *Auth) Logout(w http.ResponseWriter, r *http.Request) {
	clearSession(w, r)
	writeData(w, map[string]any{"ok": true})
}

// orgAccess is one organisation as /auth/me and the account page show it.
func orgAccess(u User) map[string]any {
	perms := u.Permissions()
	var vehicleIDs any // nil: the whole fleet
	if restrictedToFlagged(perms) {
		vehicleIDs = []int{} // units with an open repair job: Samad has none
	}
	return map[string]any{
		"id": OrgID, "code": OrgCode, "name": OrgName,
		"permissions": perms, "vehicleIds": vehicleIDs,
		"roles": []any{roleView(u.Role)},
	}
}

func (a *Auth) Me(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r.Context())
	writeData(w, map[string]any{
		"user": map[string]any{
			"id": u.ID, "email": u.Email, "fullName": u.FullName, "name": u.FullName,
			"tourSeenVersion": u.TourSeen,
		},
		"isPlatform":    u.IsPlatform(),
		"organisations": []any{orgAccess(u)},
		// The browser's Maps key, handed over only after sign-in instead of
		// being built into the public bundle. Empty: OpenStreetMap only.
		"maps": map[string]any{"googleKey": a.cfg.GoogleMapsAPIKey},
	})
}

type ctxKey struct{}

func currentUser(ctx context.Context) User {
	u, _ := ctx.Value(ctxKey{}).(User)
	return u
}

// userOf is the key alert read marks and decisions are kept under.
func userOf(ctx context.Context) string { return currentUser(ctx).Email }

// Require accepts a Bearer access token, or the refresh cookie: EventSource
// cannot send headers, and the live stream is same-origin, so it rides on
// the cookie.
func (a *Auth) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var u User
		ok := false
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			u, ok = a.session(strings.TrimPrefix(h, "Bearer "), "access")
		} else if ck, err := r.Cookie(refreshCookie); err == nil {
			u, ok = a.session(ck.Value, "refresh")
		}
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorised")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

// need lets a request through when the account holds any of perms.
func need(perms ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !holds(currentUser(r.Context()).Permissions(), perms...) {
				writeError(w, http.StatusForbidden, "Your role does not allow this")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// unitsVisible refuses a role restricted to units with an open repair job
// (technicians): Samad has no repair jobs, so no unit is theirs to see.
func unitsVisible(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if restrictedToFlagged(currentUser(r.Context()).Permissions()) {
			writeError(w, http.StatusForbidden, "No units are open to your role")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// needFunc is need for one handler.
func needFunc(h http.HandlerFunc, perms ...string) http.Handler { return need(perms...)(h) }
