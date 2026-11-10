package main

// Reefer consignments: the containers Samad's trucks carry for Maersk, kept
// as a register on the Reports page so the daily report Maersk receives
// (operator, 2026-11-10) comes out of Samad instead of a spreadsheet.
//
// Staff enter what only they know: the client, container, seal, booking, FRO
// number, the stuffing dates, when the genset went on and the three
// temperatures. The roster gives the trailer, driver, ID and phone. GPS fills
// the movement columns from the unit's geofence crossings, once a
// consignment names the zones to watch:
//
//	left             first exit from the origin zone (the empty depot)
//	arrived client   first entry into the client zone after that
//	arrived port     first entry into the port zone (Alpha or APMT) after
//	                 the truck has left the client
//	departed port    the exit from the port zone after that
//
// A time found is written onto the consignment (events are kept 30 days, a
// trip can outlive them) and never moved; a time a person typed always wins.
//
// The register lives in DATA_DIR/consignments.json, never in git.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
)

// gpsTimes are the movement times read from geofence crossings, RFC 3339.
type gpsTimes struct {
	Left          string `json:"left,omitempty"`
	ArrivedClient string `json:"arrivedClient,omitempty"`
	LeftClient    string `json:"leftClient,omitempty"` // not a column; where the port search starts
	ArrivedPort   string `json:"arrivedPort,omitempty"`
	DepartedPort  string `json:"departedPort,omitempty"`
}

// Consignment is one container on one truck. Dates are YYYY-MM-DD and times
// YYYY-MM-DDTHH:MM, in Nairobi time, as the page's inputs give them.
type Consignment struct {
	ID      string `json:"id"`
	Truck   string `json:"truck"`
	Trailer string `json:"trailer"` // blank: the roster's

	Client    string `json:"client"`
	Container string `json:"container"`
	Seal      string `json:"seal"`
	Booking   string `json:"booking"`
	FRO       string `json:"fro"`
	Zone      string `json:"zone"` // the stuffing zone, as Maersk names it
	Size      string `json:"size"`

	EmptyPickup   string `json:"emptyPickup"`   // date
	Left          string `json:"left"`          // date or time; blank: GPS
	ArrivedClient string `json:"arrivedClient"` // time; blank: GPS
	Stuffing      string `json:"stuffing"`      // date
	StuffingEnd   string `json:"stuffingEnd"`   // date or time
	GensetOn      string `json:"gensetOn"`      // time
	Position      string `json:"position"`      // blank: where GPS has it now
	ArrivedPort   string `json:"arrivedPort"`   // time; blank: GPS
	DepartedPort  string `json:"departedPort"`  // time; blank: GPS
	Offloaded     string `json:"offloaded"`     // date; the trip is done

	PackTemp string `json:"packTemp"` // °C at the pack-house
	MidTemp  string `json:"midTemp"`  // °C at the mid-stop
	PortTemp string `json:"portTemp"` // °C at Alpha, or APMT Bonje

	OriginZone string `json:"originZone"` // geofence names GPS watches
	ClientZone string `json:"clientZone"`
	PortZone   string `json:"portZone"`

	GPS gpsTimes `json:"gps"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	UpdatedBy string `json:"updatedBy"`
}

const (
	consignMax      = 2000 // the register keeps at most this many
	consignFieldMax = 80
)

type Consignments struct {
	mu   sync.Mutex
	path string
	list []Consignment
}

func NewConsignments(dir string) *Consignments {
	c := &Consignments{path: filepath.Join(dir, "consignments.json")}
	b, err := os.ReadFile(c.path)
	if errors.Is(err, fs.ErrNotExist) {
		return c
	}
	if err == nil {
		err = json.Unmarshal(b, &c.list)
	}
	if err != nil {
		log.Printf("consignments: %s unreadable, starting empty: %v", c.path, err)
		c.list = nil
	}
	return c
}

func (c *Consignments) saveLocked() error {
	b, err := json.MarshalIndent(c.list, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

// All is a copy of the register.
func (c *Consignments) All() []Consignment {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.list)
}

func (c *Consignments) Add(n Consignment) (Consignment, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.list) >= consignMax {
		return n, fmt.Errorf("the register holds %d consignments at most; delete old ones first", consignMax)
	}
	n.ID = newID()
	n.CreatedAt = n.UpdatedAt
	c.list = append(c.list, n)
	if err := c.saveLocked(); err != nil {
		c.list = c.list[:len(c.list)-1]
		return n, err
	}
	return n, nil
}

// Update replaces what a person enters on one consignment; its GPS times stay.
func (c *Consignments) Update(id string, n Consignment) (Consignment, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.list {
		if c.list[i].ID != id {
			continue
		}
		old := c.list[i]
		n.ID, n.CreatedAt, n.GPS = old.ID, old.CreatedAt, old.GPS
		// A zone changed: what was found against the old one no longer holds.
		if !strings.EqualFold(n.OriginZone, old.OriginZone) || !strings.EqualFold(n.ClientZone, old.ClientZone) ||
			!strings.EqualFold(n.PortZone, old.PortZone) || plateKey(n.Truck) != plateKey(old.Truck) || n.EmptyPickup != old.EmptyPickup {
			n.GPS = gpsTimes{}
		}
		c.list[i] = n
		if err := c.saveLocked(); err != nil {
			c.list[i] = old
			return n, true, err
		}
		return n, true, nil
	}
	return n, false, nil
}

func (c *Consignments) Delete(id string) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.list {
		if c.list[i].ID == id {
			old := slices.Clone(c.list)
			c.list = slices.Delete(c.list, i, i+1)
			if err := c.saveLocked(); err != nil {
				c.list = old
				return true, err
			}
			return true, nil
		}
	}
	return false, nil
}

// setGPS writes the times found onto the register, keeping any found before.
func (c *Consignments) setGPS(found map[string]gpsTimes) {
	if len(found) == 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	changed := false
	for i := range c.list {
		g, ok := found[c.list[i].ID]
		if !ok || g == c.list[i].GPS {
			continue
		}
		c.list[i].GPS = g
		changed = true
	}
	if changed {
		if err := c.saveLocked(); err != nil {
			log.Printf("consignments: %v", err)
		}
	}
}

// ── checking what a person typed ───────────────────────────────────────

const (
	dayLayout  = "2006-01-02"
	timeLayout = "2006-01-02T15:04"
)

// parseWhen reads a date or a date and time, in Nairobi.
func parseWhen(s string) (time.Time, bool) {
	if t, err := time.ParseInLocation(timeLayout, s, fleetZone); err == nil {
		return t, true
	}
	if t, err := time.ParseInLocation(dayLayout, s, fleetZone); err == nil {
		return t, true
	}
	return time.Time{}, false
}

func (n *Consignment) check() error {
	for _, p := range []*string{&n.Truck, &n.Trailer, &n.Client, &n.Container, &n.Seal, &n.Booking, &n.FRO,
		&n.Zone, &n.Size, &n.Position, &n.OriginZone, &n.ClientZone, &n.PortZone,
		&n.EmptyPickup, &n.Left, &n.ArrivedClient, &n.Stuffing, &n.StuffingEnd, &n.GensetOn,
		&n.ArrivedPort, &n.DepartedPort, &n.Offloaded, &n.PackTemp, &n.MidTemp, &n.PortTemp} {
		*p = clean(*p)
		if len([]rune(*p)) > consignFieldMax {
			*p = string([]rune(*p)[:consignFieldMax])
		}
	}
	n.Truck = strings.ToUpper(n.Truck)
	n.Container = strings.ToUpper(n.Container)
	if plateKey(n.Truck) == "" {
		return errors.New("pick the truck")
	}
	for _, f := range []struct{ name, v string }{
		{"Empty pick-up", n.EmptyPickup}, {"Date left", n.Left}, {"Arrived at the client", n.ArrivedClient},
		{"Stuffing date", n.Stuffing}, {"Stuffing end", n.StuffingEnd}, {"Genset on", n.GensetOn},
		{"Arrived at Alpha/APMT", n.ArrivedPort}, {"Departed Alpha/APMT", n.DepartedPort}, {"Offloaded", n.Offloaded},
	} {
		if _, ok := parseWhen(f.v); f.v != "" && !ok {
			return fmt.Errorf("%s: a date (YYYY-MM-DD) or a date and time", f.name)
		}
	}
	for _, f := range []struct{ name, v string }{{"Pack-house temperature", n.PackTemp}, {"Mid-stop temperature", n.MidTemp}, {"Alpha/APMT temperature", n.PortTemp}} {
		if f.v == "" {
			continue
		}
		t, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(strings.TrimSuffix(f.v, "°C")), "°"), 64)
		if err != nil || t < -40 || t > 40 {
			return fmt.Errorf("%s: degrees C, -40 to 40", f.name)
		}
	}
	return nil
}

// ── GPS ─────────────────────────────────────────────────────────────────

// crossingAt is one geofence crossing of one unit.
type crossingAt struct {
	zone, action string
	at           time.Time
}

// crossingsByUnit: every unit's geofence crossings, oldest first.
func crossingsByUnit(events []PEvent) map[int][]crossingAt {
	out := map[int][]crossingAt{}
	for _, e := range events {
		if reportKind(e) != "geofence" {
			continue
		}
		a, at := crossing(e), parseTime(e.OccurredAt)
		if a == "" || at.IsZero() {
			continue
		}
		out[e.VehicleID] = append(out[e.VehicleID], crossingAt{zoneName(e), a, at})
	}
	for _, l := range out {
		sort.Slice(l, func(i, j int) bool { return l[i].at.Before(l[j].at) })
	}
	return out
}

// firstCrossing is the first crossing of zone with action at or after from.
func firstCrossing(l []crossingAt, zone, action string, from time.Time) (time.Time, bool) {
	if zone == "" {
		return time.Time{}, false
	}
	for _, c := range l {
		if !c.at.Before(from) && c.action == action && strings.EqualFold(c.zone, zone) {
			return c.at, true
		}
	}
	return time.Time{}, false
}

// tripStart is where the GPS search begins: the empty pick-up day, else two
// days before the consignment was entered.
func (n Consignment) tripStart() time.Time {
	if t, ok := parseWhen(n.EmptyPickup); ok {
		return t
	}
	t := parseTime(n.CreatedAt)
	return t.Add(-48 * time.Hour)
}

// findGPS fills what the crossings show and was not found before.
func findGPS(n Consignment, l []crossingAt) gpsTimes {
	g := n.GPS
	stamp := func(t time.Time) string { return t.UTC().Format(time.RFC3339) }
	at := n.tripStart()
	if g.Left == "" {
		if t, ok := firstCrossing(l, n.OriginZone, "exit", at); ok {
			g.Left = stamp(t)
		}
	}
	if t := parseTime(g.Left); !t.IsZero() {
		at = t
	}
	if g.ArrivedClient == "" {
		if t, ok := firstCrossing(l, n.ClientZone, "entry", at); ok {
			g.ArrivedClient = stamp(t)
		}
	}
	if t := parseTime(g.ArrivedClient); !t.IsZero() {
		at = t
		if g.LeftClient == "" {
			if t, ok := firstCrossing(l, n.ClientZone, "exit", at); ok {
				g.LeftClient = stamp(t)
			}
		}
	}
	if t := parseTime(g.LeftClient); !t.IsZero() {
		at = t
	}
	// The port is looked for only once the truck has left the client, or
	// when no client zone is named.
	if g.ArrivedPort == "" && (g.LeftClient != "" || n.ClientZone == "") {
		if t, ok := firstCrossing(l, n.PortZone, "entry", at); ok {
			g.ArrivedPort = stamp(t)
		}
	}
	if t := parseTime(g.ArrivedPort); !t.IsZero() && g.DepartedPort == "" {
		if t, ok := firstCrossing(l, n.PortZone, "exit", t); ok {
			g.DepartedPort = stamp(t)
		}
	}
	return g
}

// refreshGPS looks for new crossings on every open consignment, records
// them, and returns the register as it now stands.
func (s *Server) refreshGPS() []Consignment {
	list := s.consign.All()
	ids := map[string]int{}
	for _, v := range s.store.Vehicles() {
		ids[plateKey(v.Registration)] = v.VehicleID
	}
	byUnit := crossingsByUnit(s.store.Events())
	found := map[string]gpsTimes{}
	for i, n := range list {
		if n.Offloaded != "" {
			continue
		}
		id, ok := ids[plateKey(n.Truck)]
		if !ok {
			continue
		}
		if g := findGPS(n, byUnit[id]); g != n.GPS {
			found[n.ID] = g
			list[i].GPS = g
		}
	}
	s.consign.setGPS(found)
	return list
}

// ── what the page and the report show ───────────────────────────────────

// consignView is a consignment with what Samad adds: the roster's driver
// details, the GPS times, where the truck is now and the wait at the port.
type consignView struct {
	Consignment
	Driver   string `json:"driver"`
	IDNumber string `json:"idNumber"`
	Phone    string `json:"phone"`
	TrailerR string `json:"rosterTrailer"`
	// The values shown: what was typed, else GPS ("" when neither).
	Show map[string]string `json:"show"`
	// Which of Show came from GPS.
	FromGPS []string `json:"fromGps"`
	Here    string   `json:"here"`  // where GPS has the truck now
	Delay   string   `json:"delay"` // at Alpha/APMT: "1d 4h", running while it is there
	Done    bool     `json:"done"`
}

func gpsLocal(s string) string {
	t := parseTime(s)
	if t.IsZero() {
		return ""
	}
	return eat(t).Format(timeLayout)
}

// span is a wait in days and hours: "1d 4h", "6h", "45 min".
func span(d time.Duration) string {
	if d < time.Hour {
		return fmt.Sprintf("%d min", int(math.Max(0, d.Minutes())))
	}
	h := int(d.Hours())
	if h < 24 {
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dd %dh", h/24, h%24)
}

// consignViews dresses the register for the page and the report. Where a
// truck is not inside a zone, its place is the one Google names (cached, as
// the Movements report's), else its distance from the nearest zone.
func (s *Server) consignViews(ctx context.Context, list []Consignment, now time.Time) []consignView {
	zones := s.store.Geofences()
	units := map[string]PVehicle{}
	for _, v := range s.store.Vehicles() {
		units[plateKey(v.Registration)] = v
	}
	out := make([]consignView, 0, len(list))
	for _, n := range list {
		v := consignView{Consignment: n, Show: map[string]string{}, Done: n.Offloaded != ""}
		if e, ok := s.store.rosterFor(n.Truck); ok {
			v.Driver, v.IDNumber, v.Phone, v.TrailerR = e.Driver, e.IDNumber, e.Phone, e.Trailer
		}
		u, tracked := units[plateKey(n.Truck)]
		if v.Driver == "" && tracked && u.Driver != nil {
			v.Driver = driverName(u)
		}
		for _, f := range []struct{ key, typed, gps string }{
			{"left", n.Left, n.GPS.Left}, {"arrivedClient", n.ArrivedClient, n.GPS.ArrivedClient},
			{"arrivedPort", n.ArrivedPort, n.GPS.ArrivedPort}, {"departedPort", n.DepartedPort, n.GPS.DepartedPort},
		} {
			if f.typed != "" {
				v.Show[f.key] = f.typed
			} else if g := gpsLocal(f.gps); g != "" {
				v.Show[f.key] = g
				v.FromGPS = append(v.FromGPS, f.key)
			}
		}
		if tracked && u.Position != nil && (u.Position.Latitude != 0 || u.Position.Longitude != 0) {
			in, near, km := whereNow(zones, u.Position.Latitude, u.Position.Longitude)
			switch {
			case in != "":
				v.Here = in
			case ctx.Err() == nil && s.cfg.GoogleKey() != "" && s.reports != nil:
				v.Here = s.reports.lookUp(ctx, s.cfg.GoogleKey(), u.Position.Latitude, u.Position.Longitude)
			}
			if v.Here == "" && near != "" {
				v.Here = fmt.Sprintf("%s km from %s", num(km), near)
			}
		}
		if arr, ok := parseWhen(v.Show["arrivedPort"]); ok {
			end := now
			if dep, ok := parseWhen(v.Show["departedPort"]); ok {
				end = dep
			}
			if end.After(arr) {
				v.Delay = span(end.Sub(arr))
			}
		}
		out = append(out, v)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Done != out[j].Done {
			return !out[i].Done
		}
		a, b := out[i].tripStart(), out[j].tripStart()
		if !a.Equal(b) {
			return a.Before(b)
		}
		return out[i].Truck < out[j].Truck
	})
	return out
}

// ── the routes ──────────────────────────────────────────────────────────

//	GET    /reports/consignments?org=      → { consignments, zones, trucks }
//	POST   /reports/consignments?org=      body: Consignment → the new one
//	PUT    /reports/consignments/{id}?org= body: Consignment → as saved
//	DELETE /reports/consignments/{id}?org=

func (s *Server) listConsignments(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	now := time.Now()
	zones := []string{}
	for _, g := range s.store.Geofences() {
		zones = append(zones, g.Name)
	}
	sort.Strings(zones)
	type truck struct {
		Plate   string `json:"plate"`
		Trailer string `json:"trailer"`
		Driver  string `json:"driver"`
	}
	trucks := []truck{}
	for _, v := range s.store.Vehicles() {
		t := truck{Plate: v.Registration, Trailer: v.Trailer, Driver: driverName(v)}
		trucks = append(trucks, t)
	}
	sort.Slice(trucks, func(i, j int) bool { return trucks[i].Plate < trucks[j].Plate })
	writeData(w, map[string]any{
		"consignments": s.consignViews(r.Context(), s.refreshGPS(), now),
		"zones":        zones,
		"trucks":       trucks,
	})
}

func (s *Server) readConsignment(w http.ResponseWriter, r *http.Request) (Consignment, bool) {
	var n Consignment
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&n); err != nil {
		writeError(w, http.StatusBadRequest, "the consignment could not be read")
		return n, false
	}
	if err := n.check(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return n, false
	}
	u := currentUser(r.Context())
	n.UpdatedAt, n.UpdatedBy = time.Now().UTC().Format(time.RFC3339), u.FullName
	if n.UpdatedBy == "" {
		n.UpdatedBy = u.Email
	}
	return n, true
}

func (s *Server) addConsignment(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	n, ok := s.readConsignment(w, r)
	if !ok {
		return
	}
	n.GPS = gpsTimes{}
	saved, err := s.consign.Add(n)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeData(w, saved)
}

func (s *Server) updateConsignment(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	n, ok := s.readConsignment(w, r)
	if !ok {
		return
	}
	saved, found, err := s.consign.Update(mux.Vars(r)["id"], n)
	switch {
	case !found:
		writeError(w, http.StatusNotFound, "no such consignment")
	case err != nil:
		writeError(w, http.StatusInternalServerError, "the consignment could not be saved")
	default:
		writeData(w, saved)
	}
}

func (s *Server) deleteConsignment(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	found, err := s.consign.Delete(mux.Vars(r)["id"])
	switch {
	case !found:
		writeError(w, http.StatusNotFound, "no such consignment")
	case err != nil:
		writeError(w, http.StatusInternalServerError, "the consignment could not be deleted")
	default:
		writeData(w, map[string]bool{"deleted": true})
	}
}

// ── the report ──────────────────────────────────────────────────────────

// sheetDate is a date as the sheet writes its times: 30-10-26 (the year in
// full does not fit 25 columns on one page).
func sheetDate(s string) string {
	t, ok := parseWhen(s)
	if !ok {
		return s
	}
	return t.Format("02-01-06")
}

// sheetTime is a time as the sheet writes it: 01-11-26 2050HRS; a bare date
// as sheetDate.
func sheetTime(s string) string {
	if _, err := time.ParseInLocation(timeLayout, s, fleetZone); err != nil {
		return sheetDate(s)
	}
	t, _ := parseWhen(s)
	return t.Format("02-01-06 1504") + "HRS"
}

func temp(s string) string {
	s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(strings.TrimSuffix(s, "°C")), "°"))
	return s
}

// buildReefer is the daily report: every consignment on the road, and those
// offloaded on the report's day.
func (s *Server) buildReefer(ctx context.Context, now time.Time) *ReportDoc {
	today := fleetDay(now)
	views := s.consignViews(ctx, s.refreshGPS(), now)
	var rows [][]Cell
	open, atPort := 0, 0
	for _, v := range views {
		if v.Done {
			if t, ok := parseWhen(v.Offloaded); !ok || fleetDay(t) != today {
				continue
			}
		} else {
			open++
			if v.Show["arrivedPort"] != "" && v.Show["departedPort"] == "" {
				atPort++
			}
		}
		trailer := v.Trailer
		if trailer == "" {
			trailer = v.TrailerR
		}
		unit := v.Truck
		if trailer != "" {
			unit += " / " + trailer // two lines in a narrow column
		}
		pos := v.Position
		if pos == "" {
			pos = v.Here
		}
		if v.Done {
			pos = "Offloaded"
		}
		w := func(s string) Cell { return Cell{Text: s, Wrap: true} }
		rows = append(rows, []Cell{
			{Text: unit, Bold: true, Wrap: true}, w(v.Driver), {Text: v.IDNumber}, {Text: v.Phone}, w(v.Client),
			{Text: v.Container}, {Text: v.Seal}, {Text: v.Booking}, {Text: v.FRO}, w(v.Zone), {Text: v.Size},
			w(sheetDate(v.EmptyPickup)), w(sheetTime(v.Show["left"])), w(sheetTime(v.Show["arrivedClient"])),
			w(sheetDate(v.Stuffing)), w(sheetTime(v.StuffingEnd)), w(sheetTime(v.GensetOn)), w(pos),
			w(sheetTime(v.Show["arrivedPort"])), w(sheetTime(v.Show["departedPort"])), {Text: v.Delay},
			w(sheetDate(v.Offloaded)), {Text: temp(v.PackTemp)}, {Text: temp(v.MidTemp)}, {Text: temp(v.PortTemp)},
		})
	}
	words := eat(now).Format("Mon 2 Jan 2006, 15:04")
	doc := &ReportDoc{
		Kind: "reefer", Title: "Reefer Consignments Report", ReportNo: reportNumber("RC", now),
		Date: eat(now).Format("02/01/2006"), Company: OrgName, Orientation: "landscape", Paper: "A3",
		Info: []InfoPair{
			{"Fleet", OrgName}, {"Customer", "Maersk"},
			{"On the road", strconv.Itoa(open)}, {"At Alpha/APMT", strconv.Itoa(atPort)},
			{"As at", words}, {"Generated", fmtShort(now)},
		},
		FootNote:    OrgName + " · Reefer Consignments Report · " + words,
		Filename:    "Reefer Consignments Report " + OrgName + " " + today,
		GeneratedAt: now.UTC().Format(time.RFC3339),
		Summary:     map[string]any{"open": open, "atPort": atPort, "rows": len(rows)},
	}
	if len(rows) == 0 {
		doc.Blocks = []Block{{Type: "empty", Text: "No reefer consignments on the road. Add them under Consignments."}}
		return doc
	}
	doc.Blocks = []Block{
		// Widths in millimetres of A3 landscape's 394: each holds its longest
		// value at the dense size, so nothing is cut.
		{Type: "table", Dense: true, Cols: []Col{
			{H: "Truck/Trailer", W: 17}, {H: "Driver", W: 21.5}, {H: "ID No", W: 15.5}, {H: "Mobile No", W: 18},
			{H: "Client", W: 15}, {H: "Container No", W: 21.5}, {H: "Maersk Seal", W: 21}, {H: "Booking", W: 16.5},
			{H: "FRO No", W: 17}, {H: "Stuffing Zone", W: 17}, {H: "Size", W: 8.5},
			{H: "Empty Pick-up Date", W: 15}, {H: "Date Left", W: 15}, {H: "Date Arrived Client", W: 15},
			{H: "Stuffing Date", W: 15}, {H: "Stuffing End", W: 15}, {H: "Genset Switch On", W: 15},
			{H: "Current Position", W: 21}, {H: "Arrived Alpha / APMT", W: 15}, {H: "Departed Alpha / APMT", W: 15},
			{H: "Delay at Alpha / APMT", W: 14}, {H: "Date Offloaded", W: 15},
			{H: "Pack house °C", W: 12, Right: true}, {H: "Mid-stop °C", W: 12, Right: true},
			{H: "Alpha / APMT Bonje °C", W: 12, Right: true},
		}, Rows: rows},
		{Type: "note", Text: "Date left, arrival at the client and arrival and departure at Alpha/APMT come from the truck's geofence crossings unless staff entered them. Delay at Alpha/APMT runs from arrival to departure, or to now while the truck is there."},
	}
	return doc
}
