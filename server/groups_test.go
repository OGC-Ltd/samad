package main

// User groups: a custom organisation with an uploaded logo, members, and
// what the server refuses.

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const orgGroups = "/api/v1/organisations/samad/user-groups"

// A 1×1 PNG.
var pngPixel = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
}

type groupRow struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Organisation *struct {
		Name    string  `json:"name"`
		LogoURL *string `json:"logoUrl"`
	} `json:"organisation"`
	Count struct {
		Users int `json:"users"`
	} `json:"_count"`
}

func (h *harness) raw(method, target, token string, body []byte, typ string) *httptest.ResponseRecorder {
	h.t.Helper()
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", typ)
	rec := httptest.NewRecorder()
	h.h.ServeHTTP(rec, req)
	return rec
}

func TestGroupWithCustomOrganisation(t *testing.T) {
	h := newHarness(t)
	admin, cookie := h.login()

	rec := h.do("POST", orgGroups, admin, map[string]any{
		"name": "Haulage contractors", "description": "Outside trucks", "organisationName": " Kilimo Transporters ",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	g := decodeData[groupRow](t, rec.Body.Bytes())
	if g.Organisation == nil || g.Organisation.Name != "Kilimo Transporters" || g.Organisation.LogoURL != nil {
		t.Fatalf("organisation %+v", g.Organisation)
	}
	if rec := h.do("POST", orgGroups, admin, map[string]any{"name": "haulage CONTRACTORS"}); rec.Code != http.StatusConflict {
		t.Fatalf("duplicate name: %d", rec.Code)
	}
	if rec := h.do("POST", orgGroups, admin, map[string]any{"name": "x"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("short name: %d", rec.Code)
	}

	// The logo: only real raster images, at most 512 KB.
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	if rec := h.raw("PUT", orgGroups+"/"+g.ID+"/logo", admin, svg, "image/png"); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("svg logo: %d", rec.Code)
	}
	big := append(bytes.Clone(pngPixel), make([]byte, maxLogoBytes)...)
	if rec := h.raw("PUT", orgGroups+"/"+g.ID+"/logo", admin, big, "image/png"); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("big logo: %d", rec.Code)
	}
	rec = h.raw("PUT", orgGroups+"/"+g.ID+"/logo", admin, pngPixel, "image/png")
	if rec.Code != http.StatusOK {
		t.Fatalf("logo: %d %s", rec.Code, rec.Body)
	}
	g = decodeData[groupRow](t, rec.Body.Bytes())
	if g.Organisation.LogoURL == nil || !strings.HasPrefix(*g.Organisation.LogoURL, orgGroups+"/"+g.ID+"/logo?v=") {
		t.Fatalf("logo url %+v", g.Organisation.LogoURL)
	}

	// An <img> asks with the sign-in cookie, not a header.
	rec = h.do("GET", *g.Organisation.LogoURL, "", nil, cookie)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" || !bytes.Equal(rec.Body.Bytes(), pngPixel) {
		t.Fatalf("logo served: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if rec := h.do("GET", *g.Organisation.LogoURL, "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("logo without sign-in: %d", rec.Code)
	}

	// Members show on the group and on the person's row; a deleted account leaves.
	id, _ := h.invite(admin, "driver.lead@samad.test", "supervisor")
	if rec := h.do("PUT", orgGroups+"/"+g.ID+"/users/"+id, admin, nil); rec.Code != http.StatusOK {
		t.Fatalf("add member: %d %s", rec.Code, rec.Body)
	}
	if rec := h.do("PUT", orgGroups+"/"+g.ID+"/users/nobody", admin, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("add unknown user: %d", rec.Code)
	}
	users := decodeData[[]struct {
		ID     string `json:"id"`
		Groups []struct{ ID string }
	}](t, h.do("GET", orgUsers, admin, nil).Body.Bytes())
	inGroup := 0
	for _, u := range users {
		if u.ID == id && len(u.Groups) == 1 && u.Groups[0].ID == g.ID {
			inGroup++
		}
	}
	if inGroup != 1 {
		t.Fatalf("user rows %+v", users)
	}
	if rec := h.do("DELETE", orgUsers+"/"+id+"/permanent", admin, nil); rec.Code != http.StatusOK {
		t.Fatalf("purge: %d", rec.Code)
	}
	list := decodeData[[]groupRow](t, h.do("GET", orgGroups, admin, nil).Body.Bytes())
	if len(list) != 1 || list[0].Count.Users != 0 {
		t.Fatalf("after purge %+v", list)
	}

	// Back to Samad's own: no organisation, and edits keep what they omit.
	rec = h.do("PATCH", orgGroups+"/"+g.ID, admin, map[string]any{"name": "Haulage", "organisationName": ""})
	if g = decodeData[groupRow](t, rec.Body.Bytes()); rec.Code != http.StatusOK || g.Organisation != nil {
		t.Fatalf("edit: %d %s", rec.Code, rec.Body)
	}

	if rec := h.do("DELETE", orgGroups+"/"+g.ID, admin, nil); rec.Code != http.StatusOK {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := h.do("GET", orgGroups+"/"+g.ID+"/logo", "", nil, cookie); rec.Code != http.StatusNotFound {
		t.Fatalf("logo after delete: %d", rec.Code)
	}
}

func TestGroupsNeedAssignRole(t *testing.T) {
	h := newHarness(t)
	admin, _ := h.login()
	_, sup := h.invite(admin, "sup@samad.test", "supervisor")
	if rec := h.do("POST", orgGroups, sup, map[string]any{"name": "Mine"}); rec.Code != http.StatusForbidden {
		t.Fatalf("supervisor created a group: %d", rec.Code)
	}
}
