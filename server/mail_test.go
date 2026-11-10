package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/mail"
	"net/textproto"
	"strings"
	"testing"
	"time"
)

// fakeMailer records what would have been sent, or fails with err.
type fakeMailer struct {
	sent chan Mail
	err  error
}

func newFakeMailer() *fakeMailer { return &fakeMailer{sent: make(chan Mail, 8)} }

func (f *fakeMailer) Send(_ context.Context, m Mail) error {
	if f.err != nil {
		return f.err
	}
	f.sent <- m
	return nil
}

func (f *fakeMailer) next(t *testing.T) Mail {
	t.Helper()
	select {
	case m := <-f.sent:
		return m
	case <-time.After(2 * time.Second):
		t.Fatal("no mail sent")
		return Mail{}
	}
}

func (f *fakeMailer) none(t *testing.T) {
	t.Helper()
	select {
	case m := <-f.sent:
		t.Fatalf("unexpected mail to %s: %s", m.To, m.Subject)
	case <-time.After(150 * time.Millisecond):
	}
}

func tokenIn(t *testing.T, body string) string {
	t.Helper()
	_, rest, ok := strings.Cut(body, "#setup=")
	if !ok {
		t.Fatalf("no link in %q", body)
	}
	return strings.FieldsFunc(rest, func(r rune) bool { return r == '\n' || r == '\r' || r == ' ' })[0]
}

func TestInviteIsEmailed(t *testing.T) {
	h := newHarness(t)
	fm := newFakeMailer()
	h.auth.mailer = fm
	h.auth.cfg.AppURL = "https://logistics.samadoperations.com"
	admin, _ := h.login()

	rec := h.do("POST", orgUsers+"/provision", admin, map[string]any{
		"fullName": "Mark Makokha", "email": "mark@samad.test", "roleSlugs": []string{"operator"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("provision: %d %s", rec.Code, rec.Body)
	}
	inv := decodeData[struct {
		Invite map[string]any `json:"invite"`
	}](t, rec.Body.Bytes()).Invite
	if inv["sent"] != true || inv["link"] != nil {
		t.Fatalf("invite %v: want sent, and no link handed back", inv)
	}
	m := fm.next(t)
	if m.To != "mark@samad.test" || !strings.Contains(m.Text, "Hi Mark,") ||
		!strings.Contains(m.Text, "https://logistics.samadoperations.com/#setup=") {
		t.Fatalf("mail: %+v", m)
	}
	// The emailed link sets the password.
	if rec := h.do("POST", "/api/v1/account/setup", "", map[string]string{"token": tokenIn(t, m.Text), "password": "a long enough password 1"}); rec.Code != http.StatusOK {
		t.Fatalf("setup with the emailed link: %d %s", rec.Code, rec.Body)
	}
}

func TestInviteSendFailureHandsBackTheLink(t *testing.T) {
	h := newHarness(t)
	h.auth.mailer = &fakeMailer{err: &textproto.Error{Code: 535, Msg: "5.7.8 daily sending limit reached"}}
	admin, _ := h.login()
	rec := h.do("POST", orgUsers+"/provision", admin, map[string]any{
		"fullName": "X", "email": "x@samad.test", "roleSlugs": []string{"operator"},
	})
	inv := decodeData[struct {
		Invite map[string]any `json:"invite"`
	}](t, rec.Body.Bytes()).Invite
	if inv["sent"] != false || inv["reason"] != "provider-quota" || !strings.Contains(inv["link"].(string), "#setup=") {
		t.Fatalf("invite %v", inv)
	}
}

func TestForgotPasswordEmailsAReset(t *testing.T) {
	h := newHarness(t)
	fm := newFakeMailer()
	h.auth.mailer = fm

	// An unknown address: the same answer, and nothing sent.
	if rec := h.do("POST", "/api/v1/account/forgot-password", "", map[string]string{"email": "nobody@samad.test"}); rec.Code != http.StatusOK {
		t.Fatalf("unknown: %d", rec.Code)
	}
	fm.none(t)

	if rec := h.do("POST", "/api/v1/account/forgot-password", "", map[string]string{"email": testEmail}); rec.Code != http.StatusOK {
		t.Fatalf("known: %d", rec.Code)
	}
	m := fm.next(t)
	if m.To != testEmail || !strings.Contains(m.Subject, "Reset") {
		t.Fatalf("mail: %+v", m)
	}
	// A second ask straight away is not sent again.
	h.do("POST", "/api/v1/account/forgot-password", "", map[string]string{"email": testEmail})
	fm.none(t)

	if rec := h.do("POST", "/api/v1/account/setup", "", map[string]string{"token": tokenIn(t, m.Text), "password": "a brand new password 2"}); rec.Code != http.StatusOK {
		t.Fatalf("reset with the emailed link: %d %s", rec.Code, rec.Body)
	}
	if rec := h.do("POST", "/api/v1/auth/login", "", map[string]string{"email": testEmail, "password": "a brand new password 2"}); rec.Code != http.StatusOK {
		t.Fatalf("sign in with the new password: %d", rec.Code)
	}
}

func TestMailReason(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{&textproto.Error{Code: 535, Msg: "5.7.8 Authentication failed: daily sending limit"}, "provider-quota"},
		{&textproto.Error{Code: 421, Msg: "try later"}, "provider-quota"},
		{&textproto.Error{Code: 535, Msg: "5.7.8 Authentication credentials invalid"}, "send-failed"},
		{&textproto.Error{Code: 550, Msg: "Sending from domain x is not allowed"}, "send-failed"},
		{errors.New("dial tcp: timeout"), "send-failed"},
	} {
		if got := mailReason(c.err); got != c.want {
			t.Errorf("%v: %s, want %s", c.err, got, c.want)
		}
	}
}

func TestBuildMessage(t *testing.T) {
	c := MailConfig{FromEmail: "noreply@samad.test", FromName: "Samad Resources"}
	b, err := buildMessage(c, Mail{To: "a@samad.test", ToName: "A\r\nBcc: evil@x.test", Subject: "Hi\nBcc: evil@x.test",
		Text: "line", HTML: "<p>line</p>"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	head, _, _ := strings.Cut(s, "\r\n\r\n")
	if strings.Contains(head, "\nBcc:") {
		t.Fatalf("header injection:\n%s", head)
	}
	for _, want := range []string{"From: \"Samad Resources\" <noreply@samad.test>", "multipart/alternative", "text/plain; charset=utf-8", "text/html; charset=utf-8"} {
		if !strings.Contains(s, want) {
			t.Errorf("message lacks %q", want)
		}
	}
}

func TestInviteHTMLEscapesNames(t *testing.T) {
	u := User{Email: "a@samad.test", FullName: "<b>Eve</b>", Token: &setupToken{ExpiresAt: time.Now()}}
	m := inviteMail(u, "https://x.test/#setup=t", "<script>")
	if strings.Contains(m.HTML, "<script>") || strings.Contains(m.HTML, "<b>Eve") {
		t.Fatalf("unescaped name in HTML")
	}
}

func TestNewMailerNeedsTokenAndFrom(t *testing.T) {
	if NewMailer(MailConfig{Host: "h", Password: "t"}) != nil || NewMailer(MailConfig{Host: "h", FromEmail: "a@b.c"}) != nil {
		t.Fatal("mailer on without token and From")
	}
	if NewMailer(MailConfig{Host: "h", Password: "t", FromEmail: "a@b.c"}) == nil {
		t.Fatal("mailer off with token and From")
	}
}

// The logo travels inside the message: a mail client parsing it finds the
// text, the HTML that shows cid:samad-mark, and the PNG under that id.
func TestMessageCarriesTheMark(t *testing.T) {
	u := User{Email: "a@samad.test", FullName: "Mark Makokha", Token: &setupToken{ExpiresAt: time.Now()}}
	raw, err := buildMessage(MailConfig{FromEmail: "noreply@samad.test", FromName: "Samad Resources"},
		inviteMail(u, "https://x.test/#setup=t", "Ops"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	var walk func(r io.Reader, ct string)
	walk = func(r io.Reader, ct string) {
		mt, params, err := mime.ParseMediaType(ct)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(mt, "multipart/") {
			return
		}
		mr := multipart.NewReader(r, params["boundary"])
		for {
			p, err := mr.NextPart()
			if err == io.EOF {
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			pt := p.Header.Get("Content-Type")
			sub, _, _ := mime.ParseMediaType(pt)
			if strings.HasPrefix(sub, "multipart/") {
				walk(p, pt)
				continue
			}
			body, _ := io.ReadAll(p)
			if p.Header.Get("Content-Transfer-Encoding") == "base64" {
				body, _ = base64.StdEncoding.DecodeString(strings.ReplaceAll(string(body), "\r\n", ""))
			}
			kinds[sub] = string(body)
			if sub == "image/png" && p.Header.Get("Content-ID") != "<samad-mark>" {
				t.Fatalf("image content id %q", p.Header.Get("Content-ID"))
			}
		}
	}
	walk(msg.Body, msg.Header.Get("Content-Type"))
	if !strings.Contains(kinds["text/plain"], "Hi Mark,") || !strings.Contains(kinds["text/html"], `src="cid:samad-mark"`) ||
		!strings.Contains(kinds["text/html"], "Welcome, set your password.") || kinds["image/png"] != string(samadMarkPNG) {
		t.Fatalf("parts: text %t html %t png %d bytes", kinds["text/plain"] != "", kinds["text/html"] != "", len(kinds["image/png"]))
	}
}
