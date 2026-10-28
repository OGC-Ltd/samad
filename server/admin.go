package main

// User administration and the account page: the subset of fleet-server's
// /organisations/:org/users and /account routes that the dashboard's user
// screens call, in the same shapes.
//
// Samad sends no email, so an invitation is not mailed: the response carries
// the set-password link and the screen shows it to the administrator, who
// passes it on. The link is the credential; only its hash is stored.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"slices"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"golang.org/x/crypto/bcrypt"
)

const minPasswordLength = 12 // as the set-password screen asks

// Shown to the administrator as it is.
var errNameRequired = errors.New("a name is required")

func roleView(slug string) map[string]any {
	r, ok := roleBySlug(slug)
	if !ok {
		return map[string]any{"id": slug, "slug": slug, "name": slug, "platform": false}
	}
	var org any = OrgID
	if r.Platform {
		org = nil
	}
	return map[string]any{
		"id": r.Slug, "slug": r.Slug, "name": r.Name, "description": r.Description,
		"platform": r.Platform, "organisationId": org,
	}
}

// userView is one roster row.
func userView(u User) map[string]any {
	var tokens []any
	if t := u.Token; t != nil {
		tokens = append(tokens, map[string]any{
			"purpose": t.Purpose, "createdAt": t.CreatedAt, "expiresAt": t.ExpiresAt,
			"consumedAt": t.ConsumedAt, "revokedAt": t.RevokedAt,
		})
	}
	role := roleView(u.Role)
	return map[string]any{
		"id": u.ID, "email": u.Email, "fullName": u.FullName,
		"phone": nilIfEmpty(u.Phone), "employeeId": nilIfEmpty(u.EmployeeID),
		"status": u.Status, "organisationId": OrgID,
		"createdAt": u.CreatedAt, "updatedAt": u.UpdatedAt, "lastLoginAt": u.LastLoginAt,
		"passwordChangedAt": u.PasswordChangedAt, "passwordChangeCount": u.PasswordChangeCount,
		"passwordTokens": tokens,
		"userRoles":      []any{map[string]any{"id": u.ID + ":" + u.Role, "roleId": u.Role, "role": role}},
		"isDefaultAdmin": u.Bootstrap,
	}
}

func membershipsView(u User) []any {
	return []any{map[string]any{
		"organisationId": OrgID,
		"organisation":   map[string]any{"id": OrgID, "code": OrgCode, "name": OrgName},
		"roles":          []any{roleView(u.Role)},
		"allVehicles":    true,
	}}
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return false
	}
	return true
}

func (a *Auth) setupLink(r *http.Request, token string) string {
	scheme := "http"
	if isHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host + "/#setup=" + token
}

// mayGrant: only the wildcard hands out admin and the platform roles.
func mayGrant(caller User, slug string) bool {
	if _, ok := roleBySlug(slug); !ok {
		return false
	}
	return holds(caller.Permissions(), wildcard) || slices.Contains(assignableRoleSlugs, slug)
}

// target loads the account in the path, refusing what the caller may not
// touch: the default super admin (it is set in server/.env), and anybody
// holding a role the caller could not have granted.
func (a *Auth) target(w http.ResponseWriter, r *http.Request, write bool) (User, bool) {
	u, ok := a.users.Get(mux.Vars(r)["userId"])
	if !ok {
		writeError(w, http.StatusNotFound, "no such user")
		return u, false
	}
	if !write {
		return u, true
	}
	if u.Bootstrap {
		writeError(w, http.StatusConflict, "This is the default super admin. It is set in server/.env and cannot be changed here.")
		return u, false
	}
	if !mayGrant(currentUser(r.Context()), u.Role) {
		writeError(w, http.StatusForbidden, "Only a Platform Administrator can change this account")
		return u, false
	}
	return u, true
}

// oneRole reads the single role a request names (a person holds one role).
func oneRole(w http.ResponseWriter, caller User, slugs []string) (string, bool) {
	if len(slugs) != 1 {
		writeError(w, http.StatusBadRequest, "Choose exactly one role")
		return "", false
	}
	if !mayGrant(caller, slugs[0]) {
		writeError(w, http.StatusForbidden, "You cannot grant that role")
		return "", false
	}
	return slugs[0], true
}

func (a *Auth) listUsers(w http.ResponseWriter, _ *http.Request) {
	list := a.users.List()
	rows := make([]any, 0, len(list))
	for _, u := range list {
		row := userView(u)
		row["groups"] = userGroupsView(a.groups.Of(u.ID))
		rows = append(rows, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": rows, "meta": map[string]any{"total": len(rows)}})
}

func (a *Auth) getUser(w http.ResponseWriter, r *http.Request) {
	if u, ok := a.target(w, r, false); ok {
		writeData(w, map[string]any{"user": userView(u)})
	}
}

func (a *Auth) assignableRoles(w http.ResponseWriter, r *http.Request) {
	caller := currentUser(r.Context())
	var roles []any
	if holds(caller.Permissions(), wildcard) {
		for _, d := range roleDefs {
			roles = append(roles, roleView(d.Slug))
		}
	} else {
		for _, s := range assignableRoleSlugs {
			roles = append(roles, roleView(s))
		}
	}
	writeData(w, map[string]any{"roles": roles})
}

func (a *Auth) provision(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FullName   string   `json:"fullName"`
		Email      string   `json:"email"`
		Phone      string   `json:"phone"`
		EmployeeID string   `json:"employeeId"`
		RoleSlugs  []string `json:"roleSlugs"`
	}
	if !decode(w, r, &body) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	name := strings.TrimSpace(body.FullName)
	if addr, err := mail.ParseAddress(email); err != nil || addr.Address != email {
		writeError(w, http.StatusBadRequest, "That is not an email address")
		return
	}
	if name == "" {
		writeError(w, http.StatusBadRequest, "A name is required")
		return
	}
	role, ok := oneRole(w, currentUser(r.Context()), body.RoleSlugs)
	if !ok {
		return
	}
	u, token, err := a.users.Create(email, name, strings.TrimSpace(body.Phone), strings.TrimSpace(body.EmployeeID), role)
	if errors.Is(err, errEmailTaken) {
		writeError(w, http.StatusConflict, "That address already has an account")
		return
	}
	writeData(w, map[string]any{
		"user": userView(u), "created": true,
		"invite": map[string]any{"sent": false, "reason": "no-mail", "link": a.setupLink(r, token), "expiresAt": u.Token.ExpiresAt},
	})
}

func (a *Auth) updateUser(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r, true)
	if !ok {
		return
	}
	var body struct {
		FullName   *string `json:"fullName"`
		Phone      *string `json:"phone"`
		EmployeeID *string `json:"employeeId"`
	}
	if !decode(w, r, &body) {
		return
	}
	u, err := a.users.Update(t.ID, func(u *User) error {
		if body.FullName != nil {
			n := strings.TrimSpace(*body.FullName)
			if n == "" {
				return errNameRequired
			}
			u.FullName = n
		}
		if body.Phone != nil {
			u.Phone = strings.TrimSpace(*body.Phone)
		}
		if body.EmployeeID != nil {
			u.EmployeeID = strings.TrimSpace(*body.EmployeeID)
		}
		return nil
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeData(w, map[string]any{"user": userView(u)})
}

func (a *Auth) resendInvite(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r, true)
	if !ok {
		return
	}
	if t.PasswordChangeCount > 0 {
		writeData(w, map[string]any{"invite": map[string]any{"sent": false, "reason": "account-already-active"}})
		return
	}
	var token string
	u, _ := a.users.Update(t.ID, func(u *User) error {
		token = u.newToken("INVITE", inviteTTL, time.Now().UTC())
		return nil
	})
	writeData(w, map[string]any{"invite": map[string]any{"sent": false, "reason": "no-mail", "link": a.setupLink(r, token), "expiresAt": u.Token.ExpiresAt}})
}

func (a *Auth) setStatus(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r, true)
	if !ok {
		return
	}
	var body struct {
		Status string `json:"status"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Status != statusActive && body.Status != statusSuspended {
		writeError(w, http.StatusBadRequest, "status must be ACTIVE or SUSPENDED")
		return
	}
	if t.ID == currentUser(r.Context()).ID {
		writeError(w, http.StatusConflict, "You cannot suspend yourself")
		return
	}
	u, _ := a.users.Update(t.ID, func(u *User) error {
		if u.Status != body.Status {
			u.Status = body.Status
			u.SessionVersion++ // suspending ends their sessions
		}
		return nil
	})
	writeData(w, map[string]any{"user": userView(u)})
}

// setRole serves PATCH .../role and PUT .../memberships: both set the one role.
func (a *Auth) setRole(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r, true)
	if !ok {
		return
	}
	var body struct {
		RoleSlugs []string `json:"roleSlugs"`
	}
	if !decode(w, r, &body) {
		return
	}
	caller := currentUser(r.Context())
	role, ok := oneRole(w, caller, body.RoleSlugs)
	if !ok {
		return
	}
	if t.ID == caller.ID {
		writeError(w, http.StatusConflict, "You cannot change your own role")
		return
	}
	// Live at once: every request reads the role from the store, and the
	// dashboard re-reads /auth/me on focus and every two minutes.
	u, _ := a.users.Update(t.ID, func(u *User) error { u.Role = role; return nil })
	if r.Method == http.MethodPut {
		writeData(w, membershipsView(u))
		return
	}
	writeData(w, map[string]any{"memberships": membershipsView(u), "user": userView(u)})
}

func (a *Auth) listMemberships(w http.ResponseWriter, r *http.Request) {
	if u, ok := a.target(w, r, false); ok {
		writeData(w, membershipsView(u))
	}
}

func (a *Auth) removeMembership(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusConflict, "Samad Resources is the only organisation here. Suspend or delete the account instead.")
}

func (a *Auth) purge(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r, true)
	if !ok {
		return
	}
	if t.ID == currentUser(r.Context()).ID {
		writeError(w, http.StatusConflict, "You cannot delete yourself")
		return
	}
	u, err := a.users.Delete(t.ID)
	if err != nil {
		writeError(w, http.StatusNotFound, "no such user")
		return
	}
	a.groups.Forget(u.ID)
	invites := 0
	if u.Token != nil {
		invites = 1
	}
	writeData(w, map[string]any{"removed": map[string]any{"user": 1, "roles": 1, "sessions": 0, "invites": invites}})
}

// ── the account page ──

func (a *Auth) profile(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r.Context())
	var platform []any
	if u.IsPlatform() {
		platform = append(platform, roleView(u.Role))
	}
	writeData(w, map[string]any{
		"user": map[string]any{
			"id": u.ID, "email": u.Email, "fullName": u.FullName, "phone": nilIfEmpty(u.Phone),
			"employeeId": nilIfEmpty(u.EmployeeID), "status": u.Status, "createdAt": u.CreatedAt,
			"lastLoginAt": u.LastLoginAt, "passwordChangedAt": u.PasswordChangedAt,
		},
		"organisations": []any{orgAccess(u)},
		"platformRoles": platform,
	})
}

func (a *Auth) updateProfile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FullName string `json:"fullName"`
	}
	if !decode(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.FullName)
	if name == "" {
		writeError(w, http.StatusBadRequest, "A name is required")
		return
	}
	u, _ := a.users.Update(currentUser(r.Context()).ID, func(u *User) error { u.FullName = name; return nil })
	writeData(w, map[string]any{"user": map[string]any{"id": u.ID, "email": u.Email, "fullName": u.FullName}})
}

func (a *Auth) changePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if !decode(w, r, &body) {
		return
	}
	me := currentUser(r.Context())
	if me.Bootstrap {
		writeError(w, http.StatusConflict, "The default super admin's password is set in server/.env (ADMIN_PASSWORD_HASH).")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(me.PasswordHash), []byte(body.CurrentPassword)) != nil {
		writeError(w, http.StatusBadRequest, "The current password is wrong")
		return
	}
	hash, ok := newPasswordHash(w, body.NewPassword)
	if !ok {
		return
	}
	u, _ := a.users.Update(me.ID, func(u *User) error { u.setPassword(hash, time.Now().UTC()); return nil })
	writeData(w, map[string]any{"accessToken": a.issue(w, r, u)})
}

func newPasswordHash(w http.ResponseWriter, pw string) (string, bool) {
	if len(pw) < minPasswordLength || len(pw) > 72 {
		writeError(w, http.StatusBadRequest, "A password must be 12 to 72 characters")
		return "", false
	}
	h, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not set the password")
		return "", false
	}
	return string(h), true
}

func (a *Auth) inspectSetup(w http.ResponseWriter, r *http.Request) {
	u, ok := a.users.ByToken(mux.Vars(r)["token"])
	if !ok {
		writeData(w, map[string]any{"valid": false})
		return
	}
	writeData(w, map[string]any{
		"valid": true, "purpose": u.Token.Purpose, "email": u.Email,
		"fullName": u.FullName, "expiresAt": u.Token.ExpiresAt,
	})
}

func (a *Auth) completeSetup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !decode(w, r, &body) {
		return
	}
	hash, ok := newPasswordHash(w, body.Password)
	if !ok {
		return
	}
	u, err := a.users.SetPasswordWithToken(body.Token, hash)
	if err != nil {
		writeError(w, http.StatusBadRequest, "This link is not valid any more. Ask an administrator for a new one.")
		return
	}
	writeData(w, map[string]any{"accessToken": a.issue(w, r, u), "user": map[string]any{"id": u.ID, "email": u.Email, "fullName": u.FullName}})
}

// forgotPassword answers the same whatever the address: there is no mail to
// send a link with, so an administrator issues one (resend invitation).
func (a *Auth) forgotPassword(w http.ResponseWriter, _ *http.Request) {
	writeData(w, map[string]any{"requested": true})
}

func (a *Auth) revokeAllSessions(w http.ResponseWriter, r *http.Request) {
	_, _ = a.users.Update(currentUser(r.Context()).ID, func(u *User) error { u.SessionVersion++; return nil })
	clearSession(w, r)
	writeData(w, map[string]any{"ok": true})
}

func (a *Auth) recordTour(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Version int `json:"version"`
	}
	if !decode(w, r, &body) {
		return
	}
	u, _ := a.users.Update(currentUser(r.Context()).ID, func(u *User) error {
		u.TourSeen = max(u.TourSeen, body.Version)
		return nil
	})
	writeData(w, map[string]any{"tourSeenVersion": u.TourSeen})
}
