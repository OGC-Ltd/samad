package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is everything the server reads from the environment.
type Config struct {
	Port string

	// The IntelliFleet360 Partner API: base URL and the key that covers the
	// whole Samad fleet. The key is a secret: it lives in .env, never in git.
	PartnerBaseURL string
	PartnerAPIKey  string

	// Signs access and refresh tokens.
	JWTSecret string

	// The default super admin (users.go): created on first start, and kept a
	// super admin with this password on every start.
	AdminEmail        string
	AdminName         string
	AdminPasswordHash string

	// Where the alerts feed, its cursor and the read marks are kept between
	// restarts.
	DataDir string

	// How often the live positions and the events feed are polled. The
	// partner guide asks for 30-60 s on both.
	PositionsEvery time.Duration
	EventsEvery    time.Duration

	// The Fleet summary's AI brief (insight.go). No key, no brief: the card
	// shows the facts.
	OpenAIKey     string
	OpenAIModel   string
	OpenAIBaseURL string

	// Google Routes and Weather from the server (google.go). No key, no
	// road routes, arrivals or weather layer.
	GoogleRoutingAPIKey string
	// GoogleMapsAPIKey is the dashboard's Maps key; routes and weather use it
	// when no GOOGLE_ROUTING_API_KEY of their own is set.
	GoogleMapsAPIKey string

	// Uploaded files (group logos, blobs.go): a private S3 bucket when
	// S3_BUCKET is set, DATA_DIR/files otherwise.
	S3Bucket string
	S3Region string
	S3Prefix string

	// The browser origin allowed to call the API cross-origin (the vite dev
	// server proxies, so this is only for a separately hosted UI).
	AllowOrigin string
}

// loadDotEnv sets variables from a KEY=VALUE file without overriding what
// the environment already holds. A missing file is not an error.
func loadDotEnv(path string) {
	f, err := os.Open(path) //nolint:gosec // G304: the caller passes the fixed name ".env"
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadConfig() (Config, error) {
	loadDotEnv(".env")
	c := Config{
		Port:              env("PORT", "8080"),
		PartnerBaseURL:    strings.TrimRight(env("PARTNER_BASE_URL", "https://intellifleetapi.intellifleet360.com/api"), "/"),
		PartnerAPIKey:     os.Getenv("PARTNER_API_KEY"),
		JWTSecret:         os.Getenv("JWT_SECRET"),
		AdminEmail:        strings.ToLower(os.Getenv("ADMIN_EMAIL")),
		AdminName:         env("ADMIN_NAME", "Samad Administrator"),
		AdminPasswordHash: os.Getenv("ADMIN_PASSWORD_HASH"),
		DataDir:           env("DATA_DIR", "data"),
		AllowOrigin:       os.Getenv("ALLOW_ORIGIN"),
		OpenAIKey:         os.Getenv("OPENAI_API_KEY"),
		OpenAIModel:       env("OPENAI_MODEL", "gpt-5.4-nano"),
		OpenAIBaseURL:     env("OPENAI_BASE_URL", "https://api.openai.com/v1"),

		GoogleRoutingAPIKey: os.Getenv("GOOGLE_ROUTING_API_KEY"),
		GoogleMapsAPIKey:    os.Getenv("GOOGLE_MAPS_API_KEY"),

		S3Bucket: os.Getenv("S3_BUCKET"),
		S3Region: env("S3_REGION", env("AWS_REGION", "af-south-1")),
		S3Prefix: os.Getenv("S3_PREFIX"),
	}
	var err error
	if c.PositionsEvery, err = time.ParseDuration(env("POSITIONS_EVERY", "30s")); err != nil {
		return c, fmt.Errorf("POSITIONS_EVERY: %w", err)
	}
	if c.EventsEvery, err = time.ParseDuration(env("EVENTS_EVERY", "30s")); err != nil {
		return c, fmt.Errorf("EVENTS_EVERY: %w", err)
	}
	if v := os.Getenv("SPEED_LIMIT_KMH"); v != "" {
		if speedLimitKmh, err = strconv.ParseFloat(v, 64); err != nil {
			return c, fmt.Errorf("SPEED_LIMIT_KMH: %w", err)
		}
	}
	var missing []string
	for k, v := range map[string]string{
		"PARTNER_API_KEY": c.PartnerAPIKey, "JWT_SECRET": c.JWTSecret,
		"ADMIN_EMAIL": c.AdminEmail, "ADMIN_PASSWORD_HASH": c.AdminPasswordHash,
	} {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return c, fmt.Errorf("missing settings: %s (see .env.example)", strings.Join(missing, ", "))
	}
	return c, nil
}

// GoogleKey is the key the server's Routes and Weather calls use: its own
// GOOGLE_ROUTING_API_KEY, else the dashboard's GOOGLE_MAPS_API_KEY. A key
// restricted to HTTP referrers is refused by Google for server calls; restrict
// it by the box's IP address (or by API) instead.
func (c Config) GoogleKey() string {
	if c.GoogleRoutingAPIKey != "" {
		return c.GoogleRoutingAPIKey
	}
	return c.GoogleMapsAPIKey
}
