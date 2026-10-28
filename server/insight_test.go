package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeOpenAI answers /responses with `text` as the model's output, and
// records the last request body.
func fakeOpenAI(t *testing.T, status int, text string) (*httptest.Server, *atomic.Value, *atomic.Int32) {
	t.Helper()
	var last atomic.Value
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/responses" || r.Header.Get("Authorization") != "Bearer test-key" {
			http.Error(w, `{"error":{"message":"bad request","code":"x"}}`, http.StatusUnauthorized)
			return
		}
		b, _ := io.ReadAll(r.Body)
		last.Store(string(b))
		w.WriteHeader(status)
		if status != http.StatusOK {
			_, _ = w.Write([]byte(`{"error":{"message":"quota","code":"insufficient_quota"}}`))
			return
		}
		out, _ := json.Marshal(map[string]any{
			"status": "completed",
			"output": []any{
				map[string]any{"type": "reasoning", "content": []any{}},
				map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": text}}},
			},
		})
		_, _ = w.Write(out)
	}))
	t.Cleanup(srv.Close)
	return srv, &last, &calls
}

func testFacts() fleetFacts {
	return fleetFacts{
		Total: 11, Moving: 3, Idle: 2, Offline: 6, Critical: 12,
		Alarms:          map[string]int{"No Seatbelt": 9, "Phone Use": 3},
		UnitsMostAlarms: []unitAlarms{{"KDT953D", 7}, {"KDW180N", 5}},
	}
}

// waitBrief polls until the background refresh has landed.
func waitBrief(t *testing.T, in *Insighter, f fleetFacts) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		in.mu.Lock()
		b, running := in.last, in.running
		in.mu.Unlock()
		if b != nil && !running {
			return b
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}

func TestInsightBrief(t *testing.T) {
	answer := `{"headline":"3 of 11 units are moving; 6 are not reporting.","findings":[{"kind":"alarms","text":"12 critical alarms today, mostly no seatbelt."},{"kind":"unit","text":"KDT953D has 7."}],"action":"Call the KDT953D driver about seatbelts.","risk":"HIGH"}`
	srv, last, calls := fakeOpenAI(t, http.StatusOK, answer)
	in := NewInsighter(Config{OpenAIKey: "test-key", OpenAIModel: "gpt-test", OpenAIBaseURL: srv.URL})

	now := time.Now()
	if b := in.Brief(testFacts(), now); b != nil {
		t.Fatal("a brief before the model has answered")
	}
	b := waitBrief(t, in, testFacts())
	if b == nil {
		t.Fatal("no brief")
	}
	if b["source"] != "model" || b["risk"] != "HIGH" || !strings.HasPrefix(b["msg"].(string), "3 of 11 units") {
		t.Fatalf("brief %v", b)
	}

	// The model saw the facts, structured output, and nothing kept on OpenAI's side.
	var req map[string]any
	_ = json.Unmarshal([]byte(last.Load().(string)), &req)
	if req["model"] != "gpt-test" || req["store"] != false {
		t.Fatalf("request %v", req)
	}
	if !strings.Contains(req["input"].(string), `"KDT953D"`) || !strings.Contains(req["input"].(string), `"criticalAlarmsToday":12`) {
		t.Fatalf("facts missing from input: %s", req["input"])
	}
	if f := req["text"].(map[string]any)["format"].(map[string]any); f["type"] != "json_schema" || f["strict"] != true {
		t.Fatalf("format %v", f)
	}

	// Fresh: served from the cache, no second call.
	if got := in.Brief(testFacts(), now.Add(time.Minute)); got == nil {
		t.Fatal("cached brief not served")
	}
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("%d calls, want 1 while the brief is fresh", calls.Load())
	}
	// Too old: not shown any more.
	if got := in.Brief(testFacts(), time.Now().Add(2*time.Hour)); got != nil {
		t.Fatal("a brief older than an hour was served")
	}
}

func TestInsightFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		text   string
	}{
		{"quota", http.StatusTooManyRequests, ""},
		{"not json", http.StatusOK, "Here is your summary!"},
		{"no headline", http.StatusOK, `{"headline":"","findings":[],"action":"","risk":"LOW"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, _, calls := fakeOpenAI(t, tc.status, tc.text)
			in := NewInsighter(Config{OpenAIKey: "test-key", OpenAIModel: "m", OpenAIBaseURL: srv.URL})
			now := time.Now()
			in.Brief(testFacts(), now)
			deadline := time.Now().Add(5 * time.Second)
			for {
				in.mu.Lock()
				done := !in.running && !in.failedAt.IsZero()
				in.mu.Unlock()
				if done || time.Now().After(deadline) {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if b := in.Brief(testFacts(), now.Add(time.Second)); b != nil {
				t.Fatalf("served %v after a failure", b)
			}
			time.Sleep(50 * time.Millisecond)
			if calls.Load() != 1 {
				t.Fatalf("%d calls: a failure must wait before asking again", calls.Load())
			}
		})
	}
}

func TestInsightWithoutKey(t *testing.T) {
	if NewInsighter(Config{}) != nil {
		t.Fatal("an Insighter without a key")
	}
	h := newHarness(t) // no OpenAI key: the card gets the facts
	token, _ := h.login()
	rec := h.do("GET", "/api/v1/organisations/samad/dashboard/ai-insight", token, nil)
	var out struct {
		Data struct {
			Insight map[string]any `json:"insight"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Data.Insight["source"] != "facts" {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}
