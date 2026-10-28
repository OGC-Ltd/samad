package main

// User groups: a name, the people in it, and optionally an organisation of
// its own (a contractor, a customer) with an uploaded logo. A group without
// one belongs to Samad Resources.
//
// Kept in DATA_DIR/groups.json (0600), written whole through a temporary
// file and a rename, like users.json. Logos go to the file store (blobs.go:
// S3, or the disk) as group-logos/<group id>; their type is checked from the
// bytes (PNG, JPEG, WebP or GIF; never SVG, which can carry script).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/mux"
)

const maxLogoBytes = 512 << 10

var logoTypes = []string{"image/png", "image/jpeg", "image/webp", "image/gif"}

type Group struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	OrgName     string    `json:"orgName,omitempty"` // empty: Samad's own
	LogoType    string    `json:"logoType,omitempty"`
	LogoVersion int       `json:"logoVersion,omitempty"`
	Members     []string  `json:"members"`
	CreatedByID string    `json:"createdById,omitempty"`
	CreatedBy   string    `json:"createdBy,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type Groups struct {
	mu    sync.RWMutex
	path  string
	blobs Blobs // logos
	list  []*Group
}

var (
	errNoGroup   = errors.New("no such group")
	errGroupName = errors.New("a group with that name already exists")
)

func NewGroups(dir string, blobs Blobs) *Groups {
	g := &Groups{path: filepath.Join(dir, "groups.json"), blobs: blobs}
	if b, err := os.ReadFile(g.path); err == nil {
		if err := json.Unmarshal(b, &g.list); err != nil {
			log.Printf("groups: %s unreadable, starting empty: %v", g.path, err)
		}
	}
	return g
}

func (gs *Groups) List() []Group {
	gs.mu.RLock()
	defer gs.mu.RUnlock()
	out := make([]Group, 0, len(gs.list))
	for _, g := range gs.list {
		c := *g
		c.Members = slices.Clone(g.Members)
		out = append(out, c)
	}
	return out
}

func (gs *Groups) byID(id string) *Group {
	for _, g := range gs.list {
		if g.ID == id {
			return g
		}
	}
	return nil
}

func (gs *Groups) nameTaken(name, except string) bool {
	for _, g := range gs.list {
		if g.ID != except && strings.EqualFold(g.Name, name) {
			return true
		}
	}
	return false
}

func (gs *Groups) Create(g Group) (Group, error) {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	if gs.nameTaken(g.Name, "") {
		return Group{}, errGroupName
	}
	now := time.Now().UTC()
	g.ID, g.Members, g.CreatedAt, g.UpdatedAt = newID(), []string{}, now, now
	gs.list = append(gs.list, &g)
	gs.saveLocked()
	return g, nil
}

// Update applies f to the group and saves it, unless f fails.
func (gs *Groups) Update(id string, f func(g *Group) error) (Group, error) {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	g := gs.byID(id)
	if g == nil {
		return Group{}, errNoGroup
	}
	c := *g
	c.Members = slices.Clone(g.Members)
	if err := f(&c); err != nil {
		return Group{}, err
	}
	if gs.nameTaken(c.Name, id) {
		return Group{}, errGroupName
	}
	c.UpdatedAt = time.Now().UTC()
	*g = c
	gs.saveLocked()
	return c, nil
}

func (gs *Groups) Delete(ctx context.Context, id string) error {
	gs.mu.Lock()
	i := slices.IndexFunc(gs.list, func(g *Group) bool { return g.ID == id })
	if i < 0 {
		gs.mu.Unlock()
		return errNoGroup
	}
	hadLogo := gs.list[i].LogoType != ""
	gs.list = slices.Delete(gs.list, i, i+1)
	gs.saveLocked()
	gs.mu.Unlock()
	if hadLogo {
		if err := gs.blobs.Delete(ctx, logoKey(id)); err != nil {
			log.Printf("groups: a deleted group's logo stayed: %v", err)
		}
	}
	return nil
}

// Forget takes a deleted account out of every group.
func (gs *Groups) Forget(userID string) {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	changed := false
	for _, g := range gs.list {
		if i := slices.Index(g.Members, userID); i >= 0 {
			g.Members = slices.Delete(g.Members, i, i+1)
			changed = true
		}
	}
	if changed {
		gs.saveLocked()
	}
}

// Of is every group the account is in.
func (gs *Groups) Of(userID string) []Group {
	gs.mu.RLock()
	defer gs.mu.RUnlock()
	var out []Group
	for _, g := range gs.list {
		if slices.Contains(g.Members, userID) {
			out = append(out, *g)
		}
	}
	return out
}

func logoKey(id string) string { return "group-logos/" + id }

// SetLogo stores the image and records its type; nil data removes it. The
// file store is written outside the lock: S3 is a network call.
func (gs *Groups) SetLogo(ctx context.Context, id string, data []byte, typ string) (Group, error) {
	gs.mu.RLock()
	found := gs.byID(id) != nil
	gs.mu.RUnlock()
	if !found {
		return Group{}, errNoGroup
	}
	var err error
	if data == nil {
		err = gs.blobs.Delete(ctx, logoKey(id))
	} else {
		err = gs.blobs.Put(ctx, logoKey(id), data, typ)
	}
	if err != nil {
		return Group{}, fmt.Errorf("storing the logo: %w", err)
	}
	return gs.Update(id, func(g *Group) error {
		g.LogoType = typ
		g.LogoVersion++
		return nil
	})
}

func (gs *Groups) Logo(ctx context.Context, id string) ([]byte, string, error) {
	gs.mu.RLock()
	g := gs.byID(id)
	typ := ""
	if g != nil {
		typ = g.LogoType
	}
	gs.mu.RUnlock()
	if typ == "" {
		return nil, "", errNoGroup
	}
	b, err := gs.blobs.Get(ctx, logoKey(id))
	return b, typ, err
}

func (gs *Groups) saveLocked() {
	b, err := json.MarshalIndent(gs.list, "", "  ")
	if err != nil {
		log.Printf("groups: %v", err)
		return
	}
	tmp := gs.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Printf("groups: %v", err)
		return
	}
	if err := os.Rename(tmp, gs.path); err != nil {
		log.Printf("groups: %v", err)
	}
}

// ── the API ──

// groupView is one card on the User groups page. organisation is the
// group's own (name and logo), or null for Samad's.
func groupView(g Group) map[string]any {
	var org any
	if g.OrgName != "" {
		var logo any
		if g.LogoType != "" {
			logo = fmt.Sprintf("/api/v1/organisations/%s/user-groups/%s/logo?v=%d", OrgID, g.ID, g.LogoVersion)
		}
		org = map[string]any{"name": g.OrgName, "logoUrl": logo}
	}
	var by any
	if g.CreatedBy != "" {
		by = map[string]any{"id": g.CreatedByID, "fullName": g.CreatedBy}
	}
	return map[string]any{
		"id": g.ID, "name": g.Name, "description": nilIfEmpty(g.Description),
		"organisationIds": []string{OrgID}, "organisation": org,
		"_count":    map[string]any{"users": len(g.Members)},
		"createdBy": by, "createdAt": g.CreatedAt, "updatedAt": g.UpdatedAt,
	}
}

// groupInput is the create and edit body. organisationName "" (or absent on
// create) is Samad's own; on edit, absent leaves it as it is.
type groupInput struct {
	Name             string  `json:"name"`
	Description      *string `json:"description"`
	OrganisationName *string `json:"organisationName"`
}

// apply checks the input and writes it onto g.
func (in groupInput) apply(g *Group) error {
	name := strings.TrimSpace(in.Name)
	if n := utf8.RuneCountInString(name); n < 2 || n > 100 {
		return errors.New("a group name is 2 to 100 characters")
	}
	g.Name = name
	if in.Description != nil {
		d := strings.TrimSpace(*in.Description)
		if utf8.RuneCountInString(d) > 500 {
			return errors.New("a description is at most 500 characters")
		}
		g.Description = d
	}
	if in.OrganisationName != nil {
		o := strings.TrimSpace(*in.OrganisationName)
		if utf8.RuneCountInString(o) > 100 {
			return errors.New("an organisation name is at most 100 characters")
		}
		g.OrgName = o
	}
	return nil
}

func groupFailed(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoGroup):
		writeError(w, http.StatusNotFound, "no such group")
	case errors.Is(err, errGroupName):
		writeError(w, http.StatusConflict, err.Error())
	case strings.HasPrefix(err.Error(), "storing the logo"):
		log.Printf("groups: %v", err)
		writeError(w, http.StatusBadGateway, "The logo could not be stored")
	default:
		writeError(w, http.StatusBadRequest, err.Error())
	}
}

// GET /organisations/{org}/user-groups
func (a *Auth) listGroups(w http.ResponseWriter, _ *http.Request) {
	list := a.groups.List()
	rows := make([]any, 0, len(list))
	for _, g := range list {
		rows = append(rows, groupView(g))
	}
	writeData(w, rows)
}

// POST /organisations/{org}/user-groups
func (a *Auth) createGroup(w http.ResponseWriter, r *http.Request) {
	var in groupInput
	if !decode(w, r, &in) {
		return
	}
	var g Group
	if err := in.apply(&g); err != nil {
		groupFailed(w, err)
		return
	}
	caller := currentUser(r.Context())
	g.CreatedByID, g.CreatedBy = caller.ID, caller.FullName
	created, err := a.groups.Create(g)
	if err != nil {
		groupFailed(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true, "data": groupView(created)})
}

// PATCH /organisations/{org}/user-groups/{groupId}
func (a *Auth) updateGroup(w http.ResponseWriter, r *http.Request) {
	var in groupInput
	if !decode(w, r, &in) {
		return
	}
	g, err := a.groups.Update(mux.Vars(r)["groupId"], in.apply)
	if err != nil {
		groupFailed(w, err)
		return
	}
	writeData(w, groupView(g))
}

// DELETE /organisations/{org}/user-groups/{groupId}
func (a *Auth) deleteGroup(w http.ResponseWriter, r *http.Request) {
	if err := a.groups.Delete(r.Context(), mux.Vars(r)["groupId"]); err != nil {
		groupFailed(w, err)
		return
	}
	writeData(w, map[string]any{"deleted": true})
}

// PUT and DELETE /organisations/{org}/user-groups/{groupId}/users/{userId}
func (a *Auth) setGroupMember(w http.ResponseWriter, r *http.Request) {
	v := mux.Vars(r)
	if _, ok := a.users.Get(v["userId"]); !ok {
		writeError(w, http.StatusNotFound, "no such user")
		return
	}
	add := r.Method == http.MethodPut
	g, err := a.groups.Update(v["groupId"], func(g *Group) error {
		i := slices.Index(g.Members, v["userId"])
		switch {
		case add && i < 0:
			g.Members = append(g.Members, v["userId"])
		case !add && i >= 0:
			g.Members = slices.Delete(g.Members, i, i+1)
		}
		return nil
	})
	if err != nil {
		groupFailed(w, err)
		return
	}
	writeData(w, groupView(g))
}

// PUT /organisations/{org}/user-groups/{groupId}/logo: the image itself as
// the body. DELETE removes it.
func (a *Auth) setGroupLogo(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["groupId"]
	if r.Method == http.MethodDelete {
		g, err := a.groups.SetLogo(r.Context(), id, nil, "")
		if err != nil {
			groupFailed(w, err)
			return
		}
		writeData(w, groupView(g))
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxLogoBytes+1))
	if err != nil || len(data) > maxLogoBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "A logo is at most 512 KB")
		return
	}
	typ := http.DetectContentType(data)
	if !slices.Contains(logoTypes, typ) {
		writeError(w, http.StatusUnsupportedMediaType, "A logo must be a PNG, JPEG, WebP or GIF image")
		return
	}
	g, err := a.groups.SetLogo(r.Context(), id, data, typ)
	if err != nil {
		groupFailed(w, err)
		return
	}
	writeData(w, groupView(g))
}

// GET /organisations/{org}/user-groups/{groupId}/logo, for an <img>: it
// rides on the sign-in cookie (Auth.Require).
func (a *Auth) groupLogo(w http.ResponseWriter, r *http.Request) {
	data, typ, err := a.groups.Logo(r.Context(), mux.Vars(r)["groupId"])
	if errors.Is(err, errNoGroup) || errors.Is(err, errNoBlob) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		log.Printf("groups: logo: %v", err)
		writeError(w, http.StatusBadGateway, "The logo could not be read")
		return
	}
	h := w.Header()
	h.Set("Content-Type", typ)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'")
	h.Set("Cache-Control", "private, max-age=86400") // the URL changes with the logo
	_, _ = w.Write(data)                             //nolint:gosec // G705: a raster image checked on upload, sent with its type, nosniff and a none CSP
}

// userGroupsView is the user row's groups, as the groups page reads them.
func userGroupsView(gs []Group) []any {
	out := make([]any, 0, len(gs))
	for _, g := range gs {
		out = append(out, map[string]any{"id": g.ID, "name": g.Name})
	}
	return out
}
