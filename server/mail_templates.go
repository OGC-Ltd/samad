package main

// The two emails Samad sends: an invitation to set a first password, and a
// password reset. Each goes as plain text and the same in HTML, with the SR
// mark attached inline (cid:), so it shows without "load images".
//
// The HTML repeats the screen the link opens (SetPasswordScreen): the brand
// row, that screen's own heading, one sentence, one green action. Its colours
// and face are Samad's, from src/index.scss and LoginScreen.scss.
//
// Mail clients drop CSS variables (Gmail strips any declaration holding
// var()), so the tokens live in mailTokens below and are written into the
// template as values when it is parsed: that map is the one place a colour or
// a face is declared.
//
// Hallmark · redesign: full · theme: brand (Samad: login plate, slate ink, the
// green action, the SR mark) · scope: email. html/template strips CSS
// comments, so the stamp lives here rather than in the <style> block.

import (
	"bytes"
	_ "embed"
	"html/template"
	"strings"
)

//go:embed assets/samad-mark-mail.png
var samadMarkPNG []byte

// The mark's content id in the message; the HTML shows it as cid:samad-mark.
const samadMarkCID = "samad-mark"

// mailTokens: Samad's theme, as the dashboard declares it.
var mailTokens = map[string]string{
	"plate":     "#e7edf5", // --login-plate: the ground the sheet sits on
	"sheet":     "#ffffff", // --login-sheet
	"line":      "#e2e8f0", // --color-border
	"ink":       "#0f172a", // --color-text-primary
	"ink-2":     "#475569", // --color-text-sec
	"muted":     "#5f6e83", // --color-text-muted
	"action":    "#15803d", // --accent-ok: Sign in, Set password
	"on-action": "#ffffff", // --login-on-accent
	"link":      "#0369a1", // --accent-info: links and the focus ring
	"face":      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
}

type accessMailData struct {
	Subject string
	Name    string // first name, "there" when none
	Email   string
	Link    string
	Until   string // "Fri 13 Nov 2026, 06:44 EAT"
	Inviter string // invitation only: who made the account
}

func newAccessMailData(u User, link string) accessMailData {
	d := accessMailData{Name: "there", Email: u.Email, Link: link}
	if f := strings.Fields(u.FullName); len(f) > 0 {
		d.Name = f[0]
	}
	if u.Token != nil {
		d.Until = u.Token.ExpiresAt.In(fleetZone).Format("Mon 2 Jan 2006, 15:04") + " EAT"
	}
	return d
}

func markImage() []mailImage {
	return []mailImage{{CID: samadMarkCID, Type: "image/png", Name: "samad-mark.png", Data: samadMarkPNG}}
}

// inviteMail: an administrator made an account; the link sets its password.
func inviteMail(u User, link, inviter string) Mail {
	d := newAccessMailData(u, link)
	d.Subject = "Your Samad Resources fleet dashboard account"
	d.Inviter = strings.TrimSpace(inviter)
	if d.Inviter == "" {
		d.Inviter = "An administrator"
	}
	return Mail{
		To: u.Email, ToName: u.FullName, Subject: d.Subject,
		Text: fill(`Hi {name},

{inviter} has set up an account for you on the Samad Resources fleet dashboard ({email}).

Set your password here:
{link}

The link works once, until {until}. If it has run out, ask your administrator for a new one.

Samad Resources
`, d),
		HTML:   render(inviteHTML, d),
		Inline: markImage(),
	}
}

// resetMail: someone asked to reset this account's password.
func resetMail(u User, link string) Mail {
	d := newAccessMailData(u, link)
	d.Subject = "Reset your Samad Resources password"
	return Mail{
		To: u.Email, ToName: u.FullName, Subject: d.Subject,
		Text: fill(`Hi {name},

Someone asked to reset the password for {email} on the Samad Resources fleet dashboard.

Choose a new password here:
{link}

The link works once, until {until}. If you did not ask for this, ignore this email: your password stays as it is.

Samad Resources
`, d),
		HTML:   render(resetHTML, d),
		Inline: markImage(),
	}
}

func fill(s string, d accessMailData) string {
	return strings.NewReplacer("{name}", d.Name, "{inviter}", d.Inviter, "{email}", d.Email,
		"{link}", d.Link, "{until}", d.Until).Replace(s)
}

// render runs an HTML template on fixed fields, so it cannot fail.
func render(t *template.Template, d accessMailData) string {
	var b bytes.Buffer
	_ = t.Execute(&b, d)
	return b.String()
}

// The frame both emails share. Tables and inline styles, because that is what
// mail clients render; the <style> block adds what the ones that read it can
// use (the focus ring, the narrow screen). [[token]] is a mailTokens value.
const mailShell = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>{{.Subject}}</title>
<meta name="description" content="{{.Subject}}">
<style>
:root {
  --plate: [[plate]]; --sheet: [[sheet]]; --line: [[line]]; --ink: [[ink]]; --ink-2: [[ink-2]];
  --muted: [[muted]]; --action: [[action]]; --on-action: [[on-action]]; --link: [[link]]; --face: [[face]];
}
html, body { overflow-x: clip; }
a:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
a:hover { text-decoration: underline; }
a:active { opacity: 0.86; }
@media (max-width: 520px) {
  .sheet-pad { padding-left: 24px !important; padding-right: 24px !important; }
  .title { font-size: 25px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:[[plate]];font-family:[[face]];color:[[ink]];-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:[[plate]]">{{template "preheader" .}}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:[[plate]]">
<tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;background:[[sheet]];border:1px solid [[line]];border-radius:12px">
<tr><td class="sheet-pad" style="padding:36px 40px 0">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle"><img src="cid:samad-mark" width="28" height="38" alt="" style="display:block;border:0;width:28px;height:38px"></td>
<td style="vertical-align:middle;padding-left:12px;font-family:[[face]];font-size:17px;font-weight:700;letter-spacing:0.06em;color:[[ink]]">SAMAD RESOURCES</td>
</tr></table>
</td></tr>
<tr><td class="sheet-pad" style="padding:28px 40px 0">
<h1 class="title" style="margin:0;font-family:[[face]];font-size:30px;line-height:1.16;font-weight:700;letter-spacing:-0.4px;color:[[ink]]">{{template "title"}}</h1>
</td></tr>
<tr><td class="sheet-pad" style="padding:14px 40px 0;font-family:[[face]];font-size:16px;line-height:1.55;color:[[ink-2]]">
<p style="margin:0">Hi {{.Name}},</p>
<p style="margin:10px 0 0">{{template "body" .}}</p>
</td></tr>
<tr><td class="sheet-pad" style="padding:26px 40px 0">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:[[action]];border-radius:6px"><a href="{{.Link}}" style="display:inline-block;padding:13px 22px;font-family:[[face]];font-size:15px;font-weight:600;line-height:1;color:[[on-action]];text-decoration:none;border-radius:6px">{{template "button"}}</a></td>
</tr></table>
</td></tr>
<tr><td class="sheet-pad" style="padding:18px 40px 32px;font-family:[[face]];font-size:14px;line-height:1.5;color:[[ink-2]]">{{template "after" .}}</td></tr>
<tr><td class="sheet-pad" style="padding:20px 40px 32px;border-top:1px solid [[line]];font-family:[[face]];font-size:13px;line-height:1.5;color:[[muted]]">
If the button does not work, copy this link into your browser:<br>
<a href="{{.Link}}" style="color:[[link]];word-break:break-all">{{.Link}}</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`

var (
	inviteHTML = mailTemplate(
		`Welcome, set your password.`,
		`{{.Inviter}} has set up an account for you on the Samad Resources fleet dashboard (<strong style="color:[[ink]];font-weight:600">{{.Email}}</strong>).`,
		`Set your password`,
		`The link works once, until {{.Until}}. If it has run out, ask your administrator for a new one.`)
	resetHTML = mailTemplate(
		`Choose a new password.`,
		`Someone asked to reset the password for <strong style="color:[[ink]];font-weight:600">{{.Email}}</strong> on the Samad Resources fleet dashboard.`,
		`Choose a new password`,
		`The link works once, until {{.Until}}. If you did not ask for this, ignore this email: your password stays as it is.`)
)

// mailTemplate fills the shell's parts, after writing the tokens in.
func mailTemplate(title, body, button, after string) *template.Template {
	pairs := make([]string, 0, 2*len(mailTokens))
	for k, v := range mailTokens {
		pairs = append(pairs, "[["+k+"]]", v)
	}
	tok := strings.NewReplacer(pairs...).Replace
	t := template.Must(template.New("mail").Parse(tok(mailShell)))
	template.Must(t.New("title").Parse(title))
	template.Must(t.New("body").Parse(tok(body)))
	template.Must(t.New("button").Parse(button))
	template.Must(t.New("after").Parse(after))
	template.Must(t.New("preheader").Parse(after))
	return t
}
