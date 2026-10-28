package main

// The permission vocabulary and the roles built from it, ported from
// fleet-server (src/lib/permissions.ts) so a person holds the same role, and
// the dashboard draws the same screens, in both. Keep the two in step: a slug
// renamed in one and not the other is a screen that silently vanishes.
//
// Samad has one organisation, so the "platform" roles (super_admin,
// director) and the organisation roles differ only in what they hold, and a
// person holds one role (fleet-server's rule since 2026-10-27).
//
// Unlike fleet-server, roles here are code, not data: there is no role editor.

import "slices"

// wildcard satisfies every check; only super_admin holds it, so a permission
// added later is one the super admin has without anybody granting it.
const wildcard = "platform:admin"

// flaggedOnly is a restriction, not a capability: its holders see only units
// with an open repair job. Samad has no repair jobs, so they see no units.
const flaggedOnly = "vehicle:flagged_only"

type roleDef struct {
	Slug            string   `json:"slug"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	Platform        bool     `json:"platform"`
	VehicleScopable bool     `json:"vehicleScopable"`
	Permissions     []string `json:"permissions"`
}

var (
	tracking = []string{"vehicle:read", "telemetry:read", "map:read", "notification:read"}
	mapTools = []string{"map:layers", "map:fuel_alerts", "map:filter"}

	// Everything a role confined to one organisation can be given.
	// repair:assign is deliberately not here: it is granted to `admin` alone.
	orgEverything = join(tracking, mapTools, []string{
		"map:playback",
		"dashboard:read", "trip:read",
		"analytics:read", "analytics:export",
		"report:read", "report:create", "report:export", "report:operations",
		"driver:read", "driver:export",
		"weighbridge:read", "weighbridge:create", "weighbridge:update", "weighbridge:export",
		"fuel_filling:read", "fuel_filling:create", "fuel_review:read",
		"fuel_theft:read", "fuel_theft:create",
		"sensor:read", "logbook:read",
		"repair:read", "repair:create", "repair:resolve", "repair:work_any",
		"repair:flag", "repair:assess", "repair:book", "repair:verify",
		"repair:parts_issue", "repair:parts_source",
		"vehicle:create", "vehicle:update", "vehicle:delete",
		"trip:create",
		"cargo:read", "cargo:update", "cargo:delete",
		"assignment:read", "assignment:create", "assignment:delete",
		"dispatch:read",
		"route:read", "route:create", "route:update", "route:delete",
		"geofence:read", "geofence:create", "geofence:update", "geofence:delete",
		"user:read", "role:read",
	})

	fleetScoped = join(tracking, mapTools, []string{
		"map:playback",
		"dashboard:read", "trip:read", "fuel_filling:read", "fuel_review:read",
		"sensor:read", "dispatch:read", "logbook:read",
		"weighbridge:read", "report:operations",
	})
)

var roleDefs = []roleDef{
	// ── Platform ──
	{Slug: "super_admin", Name: "Platform Administrator", Platform: true,
		Description: "Every organisation. All data and all administration. The super admin.",
		Permissions: []string{wildcard}},
	{Slug: "director", Name: "Director", Platform: true,
		Description: "Every organisation. All data, no administration.",
		Permissions: join([]string{"platform:read_all"}, orgEverything,
			[]string{"organisation:read", "fuel_theft:triage", "fuel_audit:read"})},

	// ── Organisation administration ──
	{Slug: "admin", Name: "System Administrator",
		Description: "Full access within this organisation, including its users.",
		Permissions: join(orgEverything, []string{
			"repair:assign",
			"security_case:read", "security_case:update",
			"fuel_theft:triage", "fuel_audit:read",
			"user:create", "user:update", "user:delete", "user:assign_role",
			"ingest_key:read", "ingest_key:create", "ingest_key:update", "ingest_key:delete",
		})},

	// ── Unrestricted within the organisation ──
	{Slug: "hos", Name: "Head of Section",
		Description: "Everything within this organisation.",
		Permissions: orgEverything},
	{Slug: "manager", Name: "Manager",
		Description: "Everything within this organisation.",
		Permissions: join(orgEverything, []string{"fuel_theft:triage", "fuel_audit:read"})},

	// ── Fleet operations ──
	{Slug: "fleet_manager", Name: "Fleet Manager",
		Description: "The whole fleet: vehicles, trips, routes, dispatch and fuel. Not its people.",
		Permissions: join(without(orgEverything, "user:", "role:"), []string{"fuel_theft:triage", "fuel_audit:read"})},
	{Slug: "fleet_analyst", Name: "Fleet Analyst",
		Description: "Reads the fleet and reports on it. Flags units for repair and books them in; changes nothing else.",
		Permissions: join(tracking, mapTools, []string{
			"map:playback",
			"dashboard:read", "trip:read", "sensor:read",
			"analytics:read", "analytics:export",
			"report:read", "report:export", "report:operations",
			"driver:read", "driver:export",
			"fuel_filling:read", "fuel_review:read", "fuel_theft:read", "fuel_audit:read",
			"logbook:read",
			"weighbridge:read", "weighbridge:export",
			"geofence:read", "route:read", "dispatch:read",
			"repair:read", "repair:flag", "repair:book",
		})},

	// ── Security ──
	{Slug: "head_of_security", Name: "Head of Security",
		Description: "Watching the fleet: live tracking, journey replay, geofences and fuel theft.",
		Permissions: join(tracking, mapTools, []string{
			"map:playback",
			"dashboard:read", "trip:read", "sensor:read",
			"geofence:read", "geofence:create", "geofence:update",
			"fuel_theft:read", "fuel_theft:create", "fuel_theft:triage", "fuel_audit:read", "fuel_filling:read",
			"fuel_review:read", "logbook:read",
			"driver:read",
			"report:read", "report:export", "report:operations",
			"security_case:read", "security_case:update",
		})},
	{Slug: "asst_head_of_security", Name: "Assistant Head of Security",
		Description: "The same watch, read-only — nothing here creates or amends a record.",
		Permissions: join(tracking, mapTools, []string{
			"map:playback",
			"dashboard:read", "trip:read", "sensor:read",
			"geofence:read", "fuel_theft:read", "fuel_audit:read", "fuel_filling:read",
			"fuel_review:read", "logbook:read",
			"driver:read",
			"report:read", "report:operations",
			"security_case:read",
		})},

	// ── Fleet-scoped operations ──
	{Slug: "logistics_manager", Name: "Logistics Manager", VehicleScopable: true,
		Description: "The units assigned to them, and the operations report.",
		Permissions: fleetScoped},
	{Slug: "dispatcher", Name: "Dispatch Manager", VehicleScopable: true,
		Description: "The units assigned to them, and the operations report.",
		Permissions: fleetScoped},

	// ── Supervision and tracking ──
	{Slug: "supervisor", Name: "Supervisor",
		Description: "Map, alerts, drivers, maintenance, workshop, weighbridges, logbook and fuel audit/report; no analytics, no user administration.",
		Permissions: join(without(orgEverything, "analytics:"), []string{"alerts:read", "fuel_audit:read"})},
	{Slug: "operator", Name: "Operator", VehicleScopable: true,
		Description: "Map, alerts, drivers, maintenance, units, weighbridge, fuel audit and vehicle fuel analysis for assigned units.",
		Permissions: join(tracking, mapTools, []string{
			"alerts:read", "map:playback", "driver:read",
			"report:read", "report:export", "report:operations",
			"weighbridge:read", "sensor:read",
			"fuel_filling:read", "fuel_audit:read",
		})},
	{Slug: "technician", Name: "Technician",
		Description: "Units flagged for repair: the live map, units and in transit for those units only; Maintenance probes, malfunctions and repairs; the Workshop ControlTech queue.",
		Permissions: join(tracking, []string{
			"map:layers", flaggedOnly,
			"sensor:read",
			"repair:read", "repair:create", "repair:resolve",
			"repair:claim", "repair:parts_source",
			"fuel_theft:triage",
		})},

	// ── Back office ──
	{Slug: "hr", Name: "Human Resources (HR)",
		Description: "People: drivers, their records and their reports. No tracking.",
		Permissions: []string{"dashboard:read", "driver:read", "driver:export", "report:read", "report:export", "user:read"}},
	{Slug: "accountant", Name: "Finance Manager",
		Description: "Money: fuel spend, refills and trip totals. No tracking.",
		Permissions: []string{
			"dashboard:read", "trip:read", "vehicle:read",
			"analytics:read", "analytics:export",
			"report:read", "report:export",
			"fuel_filling:read", "fuel_review:read", "weighbridge:read",
		}},
}

// assignableRoleSlugs are the roles an organisation administrator may hand
// out, in the order the picker lists them. Only the wildcard may grant the
// rest (admin and the platform roles).
var assignableRoleSlugs = []string{
	"hr", "fleet_manager", "fleet_analyst", "dispatcher", "manager", "accountant",
	"head_of_security", "asst_head_of_security", "supervisor", "operator", "technician",
}

func roleBySlug(slug string) (roleDef, bool) {
	for _, r := range roleDefs {
		if r.Slug == slug {
			return r, true
		}
	}
	return roleDef{}, false
}

// holds reports whether perms satisfies any of needed.
func holds(perms []string, needed ...string) bool {
	if slices.Contains(perms, wildcard) {
		return true
	}
	for _, n := range needed {
		if slices.Contains(perms, n) {
			return true
		}
	}
	return false
}

// restrictedToFlagged reads the restriction straight off the grants: the
// wildcard must not narrow a super admin.
func restrictedToFlagged(perms []string) bool {
	return slices.Contains(perms, flaggedOnly) && !slices.Contains(perms, wildcard)
}

func join(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		for _, s := range l {
			if !slices.Contains(out, s) {
				out = append(out, s)
			}
		}
	}
	return out
}

// without drops every slug starting with one of the prefixes.
func without(list []string, prefixes ...string) []string {
	var out []string
outer:
	for _, s := range list {
		for _, p := range prefixes {
			if len(s) >= len(p) && s[:len(p)] == p {
				continue outer
			}
		}
		out = append(out, s)
	}
	return out
}
