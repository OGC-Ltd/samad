package main

// Roles and user administration: the default super admin, invitations,
// what each role may reach, and what the user screens refuse.

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
)

const orgUsers = "/api/v1/organisations/samad/users"

func decodeData[T any](t *testing.T, body []byte) T {
	t.Helper()
	var out struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return out.Data
}

type meView struct {
	User struct {
		ID, Email string
	} `json:"user"`
	IsPlatform    bool `json:"isPlatform"`
	Organisations []struct {
		Permissions []string `json:"permissions"`
		VehicleIDs  []int    `json:"vehicleIds"`
	} `json:"organisations"`
}

func (h *harness) me(token string) meView {
	h.t.Helper()
	rec := h.do("GET", "/api/v1/auth/me", token, nil)
	if rec.Code != http.StatusOK {
		h.t.Fatalf("me: %d %s", rec.Code, rec.Body)
	}
	return decodeData[meView](h.t, rec.Body.Bytes())
}

// invite provisions an account with role, sets its password through the
// link, and returns its id and an access token.
func (h *harness) invite(admin, email, role string) (string, string) {
	h.t.Helper()
	rec := h.do("POST", orgUsers+"/provision", admin, map[string]any{
		"fullName": "Test " + role, "email": email, "roleSlugs": []string{role},
	})
	if rec.Code != http.StatusOK {
		h.t.Fatalf("provision %s: %d %s", role, rec.Code, rec.Body)
	}
	out := decodeData[struct {
		User   struct{ ID string } `json:"user"`
		Invite struct {
			Sent bool
			Link string
		} `json:"invite"`
	}](h.t, rec.Body.Bytes())
	_, token, ok := strings.Cut(out.Invite.Link, "#setup=")
	if !ok || out.Invite.Sent {
		h.t.Fatalf("invite %+v", out.Invite)
	}
	// Pending until the link is used: no password, no sign-in.
	if rec := h.do("POST", "/api/v1/auth/login", "", map[string]string{"email": email, "password": ""}); rec.Code != http.StatusUnauthorized {
		h.t.Fatalf("pending account signed in: %d", rec.Code)
	}
	if info := decodeData[map[string]any](h.t, h.do("GET", "/api/v1/account/setup/"+token, "", nil).Body.Bytes()); info["valid"] != true || info["email"] != email {
		h.t.Fatalf("setup info %v", info)
	}
	if rec := h.do("POST", "/api/v1/account/setup", "", map[string]string{"token": token, "password": "short"}); rec.Code != http.StatusBadRequest {
		h.t.Fatalf("short password accepted: %d", rec.Code)
	}
	rec = h.do("POST", "/api/v1/account/setup", "", map[string]string{"token": token, "password": "a long enough password"})
	if rec.Code != http.StatusOK {
		h.t.Fatalf("setup: %d %s", rec.Code, rec.Body)
	}
	// Single use.
	if rec := h.do("POST", "/api/v1/account/setup", "", map[string]string{"token": token, "password": "a long enough password"}); rec.Code != http.StatusBadRequest {
		h.t.Fatalf("link used twice: %d", rec.Code)
	}
	return out.User.ID, decodeData[struct{ AccessToken string }](h.t, rec.Body.Bytes()).AccessToken
}

func TestDefaultSuperAdmin(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	me := h.me(token)
	if me.User.Email != testEmail || !me.IsPlatform || !slices.Contains(me.Organisations[0].Permissions, wildcard) {
		t.Fatalf("me %+v", me)
	}
	// The screens refuse to change it: it is set in server/.env.
	for _, c := range []struct{ method, path string }{
		{"PATCH", "/status"}, {"PATCH", "/role"}, {"DELETE", "/permanent"},
	} {
		rec := h.do(c.method, orgUsers+"/"+me.User.ID+c.path, token, map[string]any{"status": "SUSPENDED", "roleSlugs": []string{"operator"}})
		if rec.Code != http.StatusConflict {
			t.Errorf("%s %s on the default admin: %d %s", c.method, c.path, rec.Code, rec.Body)
		}
	}
	if rec := h.do("PATCH", "/api/v1/account/password", token, map[string]string{"currentPassword": testPassword, "newPassword": "another long password"}); rec.Code != http.StatusConflict {
		t.Errorf("default admin changed its password here: %d", rec.Code)
	}
}

func TestRolesReachTheirScreens(t *testing.T) {
	h := newHarness(t)
	admin, _ := h.login()

	_, operator := h.invite(admin, "op@samad.test", "operator")
	perms := h.me(operator).Organisations[0].Permissions
	if !slices.Contains(perms, "map:read") || slices.Contains(perms, "user:read") {
		t.Fatalf("operator permissions %v", perms)
	}
	for path, allowed := range map[string]bool{
		"/api/v1/organisations/samad/vehicles/snapshot":          true,
		"/api/v1/alerts/summary":                                 true,
		"/api/v1/organisations/samad/analytics/drivers/overview": true,
		"/api/v1/organisations/samad/dashboard/ai-insight":       false, // no dashboard:read
		orgUsers: false,
	} {
		if rec := h.do("GET", path, operator, nil); (rec.Code != http.StatusForbidden) != allowed {
			t.Errorf("operator GET %s: %d, allowed=%v", path, rec.Code, allowed)
		}
	}

	// HR: people, no tracking.
	_, hr := h.invite(admin, "hr@samad.test", "hr")
	if rec := h.do("GET", "/api/v1/organisations/samad/vehicles/snapshot", hr, nil); rec.Code != http.StatusForbidden {
		t.Errorf("hr snapshot: %d", rec.Code)
	}
	if rec := h.do("GET", orgUsers, hr, nil); rec.Code != http.StatusOK {
		t.Errorf("hr users: %d", rec.Code)
	}

	// Technician: units with an open repair job only, and Samad has none.
	_, tech := h.invite(admin, "tech@samad.test", "technician")
	if me := h.me(tech); me.Organisations[0].VehicleIDs == nil || len(me.Organisations[0].VehicleIDs) != 0 {
		t.Errorf("technician vehicleIds %v", me.Organisations[0].VehicleIDs)
	}
	if rec := h.do("GET", "/api/v1/organisations/samad/live", tech, nil); rec.Code != http.StatusForbidden {
		t.Errorf("technician live: %d", rec.Code)
	}
}

func TestOrgAdminLimits(t *testing.T) {
	h := newHarness(t)
	root, _ := h.login()
	adminID, admin := h.invite(root, "sysadmin@samad.test", "admin")

	// An organisation admin cannot hand out admin or platform roles.
	roles := decodeData[struct {
		Roles []struct{ Slug string } `json:"roles"`
	}](t, h.do("GET", orgUsers+"/assignable-roles", admin, nil).Body.Bytes()).Roles
	for _, r := range roles {
		if r.Slug == "super_admin" || r.Slug == "director" || r.Slug == "admin" {
			t.Errorf("org admin offered %s", r.Slug)
		}
	}
	if rec := h.do("POST", orgUsers+"/provision", admin, map[string]any{"fullName": "X", "email": "x@samad.test", "roleSlugs": []string{"super_admin"}}); rec.Code != http.StatusForbidden {
		t.Errorf("org admin granted super_admin: %d", rec.Code)
	}
	if rec := h.do("PATCH", orgUsers+"/"+adminID+"/role", admin, map[string]any{"roleSlugs": []string{"manager"}}); rec.Code != http.StatusForbidden && rec.Code != http.StatusConflict {
		t.Errorf("org admin changed own role: %d", rec.Code)
	}

	// The super admin promotes, and the change is live at once.
	opID, op := h.invite(root, "op2@samad.test", "operator")
	if rec := h.do("PATCH", orgUsers+"/"+opID+"/role", root, map[string]any{"roleSlugs": []string{"manager"}}); rec.Code != http.StatusOK {
		t.Fatalf("promote: %d %s", rec.Code, rec.Body)
	}
	if rec := h.do("GET", "/api/v1/organisations/samad/dashboard/ai-insight", op, nil); rec.Code != http.StatusOK {
		t.Errorf("promoted manager ai-insight: %d", rec.Code)
	}

	// Suspending ends their sessions and stops sign-in.
	if rec := h.do("PATCH", orgUsers+"/"+opID+"/status", admin, map[string]any{"status": "SUSPENDED"}); rec.Code != http.StatusOK {
		t.Fatalf("suspend: %d %s", rec.Code, rec.Body)
	}
	if rec := h.do("GET", "/api/v1/auth/me", op, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("suspended token still works: %d", rec.Code)
	}
	if rec := h.do("POST", "/api/v1/auth/login", "", map[string]string{"email": "op2@samad.test", "password": "a long enough password"}); rec.Code != http.StatusForbidden {
		t.Errorf("suspended sign-in: %d", rec.Code)
	}

	// The roster lists everybody with one role each.
	rows := decodeData[[]map[string]any](t, h.do("GET", orgUsers, admin, nil).Body.Bytes())
	if len(rows) != 3 {
		t.Errorf("roster has %d rows", len(rows))
	}
	if rec := h.do("DELETE", orgUsers+"/"+opID+"/permanent", admin, nil); rec.Code != http.StatusOK {
		t.Errorf("delete: %d %s", rec.Code, rec.Body)
	}
}
