package main

// The Fleet summary card's AI brief: an OpenAI model rewrites the card's
// facts (fleetFacts) as a short brief for an operator. It is given those
// facts and nothing else (counts, alarm labels, plates, no driver names),
// and told to state nothing they do not hold.
//
// A brief is made at most every briefEvery, in the background: the card
// gets the latest one at once and never waits on the model. Until the first
// is ready, or whenever the model fails, the card shows the facts.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	briefEvery    = 10 * time.Minute // how often a new brief is asked for
	briefMaxAge   = time.Hour        // older than this, the card shows the facts
	briefRetry    = 2 * time.Minute  // after a failure, wait this long
	briefTimeout  = 45 * time.Second
	briefMaxBytes = 1 << 20
)

type Insighter struct {
	key, model, base string
	client           *http.Client

	mu       sync.Mutex
	last     map[string]any
	lastAt   time.Time
	failedAt time.Time
	running  bool
}

func NewInsighter(cfg Config) *Insighter {
	if cfg.OpenAIKey == "" {
		return nil
	}
	return &Insighter{
		key: cfg.OpenAIKey, model: cfg.OpenAIModel, base: strings.TrimRight(cfg.OpenAIBaseURL, "/"),
		client: &http.Client{Timeout: briefTimeout},
	}
}

// Brief is the latest model brief, or nil when there is none young enough.
// A stale one starts a refresh in the background.
func (in *Insighter) Brief(f fleetFacts, now time.Time) map[string]any {
	in.mu.Lock()
	defer in.mu.Unlock()
	if !in.running && now.Sub(in.lastAt) >= briefEvery && now.Sub(in.failedAt) >= briefRetry {
		in.running = true
		go in.refresh(f)
	}
	if in.last == nil || now.Sub(in.lastAt) > briefMaxAge {
		return nil
	}
	return in.last
}

func (in *Insighter) refresh(f fleetFacts) {
	ctx, cancel := context.WithTimeout(context.Background(), briefTimeout)
	defer cancel()
	brief, err := in.ask(ctx, f)
	in.mu.Lock()
	defer in.mu.Unlock()
	in.running = false
	if err != nil {
		log.Printf("ai insight: %v", err)
		in.failedAt = time.Now()
		return
	}
	in.last, in.lastAt = brief, time.Now()
}

const briefInstructions = `You write the Fleet summary for Samad Resources' fleet dashboard: a short brief an operations supervisor reads at a glance.

Use ONLY the facts in the user message. Never invent units, drivers, places, causes, times or numbers that are not in them. Use plain, direct language and Kenyan English spelling.

- headline: one sentence on the fleet's state right now.
- findings: up to 4 short sentences, the most important first: alarm patterns, which units stand out, units not reporting. Each has a kind: "alarms", "unit", "offline" or "status".
- action: one sentence, the single most useful thing to do next, or "No action needed." when nothing calls for one.
- risk: LOW, MEDIUM or HIGH. HIGH when there are 10 or more critical alarms today; MEDIUM for any critical alarm, or when most units are not reporting; otherwise LOW.`

// The shape the model must answer in (Structured Outputs).
var briefSchema = map[string]any{
	"type":                 "object",
	"additionalProperties": false,
	"required":             []string{"headline", "findings", "action", "risk"},
	"properties": map[string]any{
		"headline": map[string]any{"type": "string"},
		"findings": map[string]any{
			"type":     "array",
			"maxItems": 4,
			"items": map[string]any{
				"type":                 "object",
				"additionalProperties": false,
				"required":             []string{"kind", "text"},
				"properties": map[string]any{
					"kind": map[string]any{"type": "string", "enum": []string{"alarms", "unit", "offline", "status"}},
					"text": map[string]any{"type": "string"},
				},
			},
		},
		"action": map[string]any{"type": "string"},
		"risk":   map[string]any{"type": "string", "enum": []string{"LOW", "MEDIUM", "HIGH"}},
	},
}

func (in *Insighter) ask(ctx context.Context, f fleetFacts) (map[string]any, error) {
	facts, err := json.Marshal(map[string]any{
		"unitsTotal": f.Total, "moving": f.Moving, "idle": f.Idle, "offline": f.Offline,
		"criticalAlarmsToday": f.Critical, "alarmsTodayByType": f.Alarms,
		"unitsWithMostCriticalAlarmsToday": f.UnitsMostAlarms,
	})
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(map[string]any{
		"model":             in.model,
		"instructions":      briefInstructions,
		"input":             "Facts (JSON):\n" + string(facts),
		"reasoning":         map[string]any{"effort": "low"},
		"max_output_tokens": 2000,
		"store":             false,
		"text": map[string]any{"format": map[string]any{
			"type": "json_schema", "name": "fleet_brief", "strict": true, "schema": briefSchema,
		}},
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, in.base+"/responses", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+in.key)
	req.Header.Set("Content-Type", "application/json")
	res, err := in.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, briefMaxBytes))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error struct{ Message, Code string } `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		return nil, fmt.Errorf("openai %d %s: %s", res.StatusCode, e.Error.Code, e.Error.Message)
	}

	var out struct {
		Status string `json:"status"`
		Output []struct {
			Type    string `json:"type"`
			Content []struct {
				Type    string `json:"type"`
				Text    string `json:"text"`
				Refusal string `json:"refusal"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("openai: %w", err)
	}
	if out.Status != "completed" {
		return nil, fmt.Errorf("openai: response %s", out.Status)
	}
	var text string
	for _, o := range out.Output {
		for _, c := range o.Content {
			if c.Refusal != "" {
				return nil, errors.New("openai: refused")
			}
			if o.Type == "message" && c.Type == "output_text" {
				text += c.Text
			}
		}
	}
	var b struct {
		Headline string           `json:"headline"`
		Findings []map[string]any `json:"findings"`
		Action   string           `json:"action"`
		Risk     string           `json:"risk"`
	}
	if err := json.Unmarshal([]byte(text), &b); err != nil {
		return nil, fmt.Errorf("openai: no brief in the answer: %w", err)
	}
	if b.Headline == "" {
		return nil, errors.New("openai: the brief has no headline")
	}
	if b.Findings == nil {
		b.Findings = []map[string]any{}
	}
	msg := b.Headline
	for _, x := range b.Findings {
		if t, ok := x["text"].(string); ok {
			msg += " " + t
		}
	}
	return map[string]any{
		"msg": msg, "headline": b.Headline, "findings": b.Findings, "action": b.Action,
		"risk": b.Risk, "source": "model", "model": in.model,
		"generatedAt": time.Now().UTC().Format(time.RFC3339),
	}, nil
}
