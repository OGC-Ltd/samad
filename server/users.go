package main

// Accounts: who can sign in, with which role (roles.go).
//
// Kept in DATA_DIR/users.json (0600), beside state.json, written whole on
// every change through a temporary file and a rename. A roster of tens of
// people needs nothing more; the users table in the database is where they
// move once the rest of the store does.
//
// The account in server/.env (ADMIN_EMAIL, ADMIN_PASSWORD_HASH) is the
// default super admin. Every start makes sure it exists, holds super_admin,
// is active and signs in with the .env password, so nobody can lock Samad out
// of its own dashboard through the user screens; those screens refuse to
// change it for the same reason.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	statusActive    = "ACTIVE"
	statusSuspended = "SUSPENDED"

	inviteTTL = 72 * time.Hour
	resetTTL  = time.Hour
)

// setupToken is a set-password link. Only its hash is kept.
type setupToken struct {
	Hash       string     `json:"hash"`
	Purpose    string     `json:"purpose"` // INVITE or RESET
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	ConsumedAt *time.Time `json:"consumedAt,omitempty"`
	RevokedAt  *time.Time `json:"revokedAt,omitempty"`
}

type User struct {
	ID         string `json:"id"`
	Email      string `json:"email"`
	FullName   string `json:"fullName"`
	Phone      string `json:"phone,omitempty"`
	EmployeeID string `json:"employeeId,omitempty"`
	// OrgName: the custom organisation they work for, "" for Samad's own.
	// Set by hand or by joining a group that has one (groups.go).
	OrgName             string      `json:"orgName,omitempty"`
	Status              string      `json:"status"`
	Role                string      `json:"role"`
	PasswordHash        string      `json:"passwordHash,omitempty"`
	PasswordChangedAt   *time.Time  `json:"passwordChangedAt,omitempty"`
	PasswordChangeCount int         `json:"passwordChangeCount"`
	Token               *setupToken `json:"token,omitempty"`
	// Bumped to end every session: a token carries the version it was
	// issued under and stops working once it differs.
	SessionVersion int        `json:"sessionVersion"`
	TourSeen       int        `json:"tourSeenVersion"`
	Bootstrap      bool       `json:"bootstrap,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
	LastLoginAt    *time.Time `json:"lastLoginAt,omitempty"`
}

// Permissions are the role's, or none for an unknown role.
func (u User) Permissions() []string {
	r, _ := roleBySlug(u.Role)
	return r.Permissions
}

func (u User) IsPlatform() bool {
	r, _ := roleBySlug(u.Role)
	return r.Platform
}

type Users struct {
	mu   sync.RWMutex
	path string
	list []*User
}

var (
	errNoUser       = errors.New("no such user")
	errEmailTaken   = errors.New("that address already has an account")
	errTokenInvalid = errors.New("this link is not valid any more")
)

func NewUsers(dir string) *Users {
	u := &Users{path: filepath.Join(dir, "users.json")}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		log.Printf("users: %v", err)
	}
	if b, err := os.ReadFile(u.path); err == nil {
		if err := json.Unmarshal(b, &u.list); err != nil {
			log.Printf("users: %s unreadable, starting empty: %v", u.path, err)
		}
	}
	return u
}

// Bootstrap makes the .env account the default super admin (see above).
func (us *Users) Bootstrap(email, name, hash string) {
	us.mu.Lock()
	defer us.mu.Unlock()
	now := time.Now().UTC()
	u := us.byEmail(email)
	if u == nil {
		u = &User{ID: newID(), Email: email, FullName: name, CreatedAt: now}
		us.list = append(us.list, u)
		log.Printf("users: created the default super admin %s", email)
	}
	// Only the current .env account is the bootstrap one.
	for _, o := range us.list {
		o.Bootstrap = o == u
	}
	if u.PasswordHash != hash {
		u.PasswordHash = hash
		u.SessionVersion++
	}
	if u.PasswordChangeCount == 0 {
		u.PasswordChangeCount = 1
	}
	u.Role, u.Status, u.UpdatedAt = "super_admin", statusActive, now
	us.saveLocked()
}

func (us *Users) byEmail(email string) *User {
	for _, u := range us.list {
		if strings.EqualFold(u.Email, email) {
			return u
		}
	}
	return nil
}

func (us *Users) byID(id string) *User {
	for _, u := range us.list {
		if u.ID == id {
			return u
		}
	}
	return nil
}

// Get returns a copy, so callers never hold a pointer into the store.
func (us *Users) Get(id string) (User, bool) {
	us.mu.RLock()
	defer us.mu.RUnlock()
	if u := us.byID(id); u != nil {
		return *u, true
	}
	return User{}, false
}

func (us *Users) GetByEmail(email string) (User, bool) {
	us.mu.RLock()
	defer us.mu.RUnlock()
	if u := us.byEmail(email); u != nil {
		return *u, true
	}
	return User{}, false
}

func (us *Users) List() []User {
	us.mu.RLock()
	defer us.mu.RUnlock()
	out := make([]User, 0, len(us.list))
	for _, u := range us.list {
		out = append(out, *u)
	}
	slices.SortFunc(out, func(a, b User) int { return strings.Compare(strings.ToLower(a.FullName), strings.ToLower(b.FullName)) })
	return out
}

// Create adds an account with no password and an invitation, and returns
// the account and the invitation's token.
func (us *Users) Create(email, name, phone, employeeID, role string) (User, string, error) {
	us.mu.Lock()
	defer us.mu.Unlock()
	if us.byEmail(email) != nil {
		return User{}, "", errEmailTaken
	}
	now := time.Now().UTC()
	u := &User{
		ID: newID(), Email: email, FullName: name, Phone: phone, EmployeeID: employeeID,
		Status: statusActive, Role: role, CreatedAt: now, UpdatedAt: now,
	}
	token := u.newToken("INVITE", inviteTTL, now)
	us.list = append(us.list, u)
	us.saveLocked()
	return *u, token, nil
}

// Update applies f to the account and saves it.
func (us *Users) Update(id string, f func(u *User) error) (User, error) {
	us.mu.Lock()
	defer us.mu.Unlock()
	u := us.byID(id)
	if u == nil {
		return User{}, errNoUser
	}
	if err := f(u); err != nil {
		return User{}, err
	}
	u.UpdatedAt = time.Now().UTC()
	us.saveLocked()
	return *u, nil
}

func (us *Users) Delete(id string) (User, error) {
	us.mu.Lock()
	defer us.mu.Unlock()
	for i, u := range us.list {
		if u.ID == id {
			us.list = slices.Delete(us.list, i, i+1)
			us.saveLocked()
			return *u, nil
		}
	}
	return User{}, errNoUser
}

// ByToken finds the account a live set-password token belongs to.
func (us *Users) ByToken(token string) (User, bool) {
	us.mu.RLock()
	defer us.mu.RUnlock()
	u := us.byTokenLocked(token, time.Now())
	if u == nil {
		return User{}, false
	}
	return *u, true
}

func (us *Users) byTokenLocked(token string, now time.Time) *User {
	h := hashToken(token)
	for _, u := range us.list {
		t := u.Token
		if t != nil && t.Hash == h && t.ConsumedAt == nil && t.RevokedAt == nil && now.Before(t.ExpiresAt) {
			return u
		}
	}
	return nil
}

// SetPasswordWithToken spends the token and sets the password.
func (us *Users) SetPasswordWithToken(token, hash string) (User, error) {
	us.mu.Lock()
	defer us.mu.Unlock()
	now := time.Now().UTC()
	u := us.byTokenLocked(token, now)
	if u == nil || u.Status != statusActive {
		return User{}, errTokenInvalid
	}
	u.Token.ConsumedAt = &now
	u.setPassword(hash, now)
	us.saveLocked()
	return *u, nil
}

// newToken replaces any earlier link with a new one and returns it.
func (u *User) newToken(purpose string, ttl time.Duration, now time.Time) string {
	if u.Token != nil && u.Token.ConsumedAt == nil && u.Token.RevokedAt == nil {
		u.Token.RevokedAt = &now
	}
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	token := base64.RawURLEncoding.EncodeToString(b)
	u.Token = &setupToken{Hash: hashToken(token), Purpose: purpose, CreatedAt: now, ExpiresAt: now.Add(ttl)}
	return token
}

func (u *User) setPassword(hash string, now time.Time) {
	u.PasswordHash = hash
	u.PasswordChangedAt = &now
	u.PasswordChangeCount++
	u.SessionVersion++
	u.UpdatedAt = now
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (us *Users) saveLocked() {
	b, err := json.MarshalIndent(us.list, "", "  ")
	if err != nil {
		log.Printf("users: %v", err)
		return
	}
	tmp := us.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Printf("users: %v", err)
		return
	}
	if err := os.Rename(tmp, us.path); err != nil {
		log.Printf("users: %v", err)
	}
}
