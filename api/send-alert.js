import nodemailer from "nodemailer";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
  const ALERT_EMAIL = process.env.ALERT_EMAIL;

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return res.status(500).json({
      error: "Email not configured",
      hint: "Add GMAIL_USER and GMAIL_APP_PASSWORD to Vercel environment variables",
    });
  }

  const { roles = [], to, preview = false } = req.body || {};
  const recipient = to || ALERT_EMAIL || GMAIL_USER;

  // Preview mode — return HTML without sending
  if (preview) {
    return res.status(200).json({ success: true, preview: true, html: buildHtml(roles), recipient });
  }

  if (!roles.length) {
    return res.status(200).json({ success: true, skipped: true, reason: "No roles to send" });
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  try {
    const info = await transporter.sendMail({
      from: `"Executive Search Agent" <${GMAIL_USER}>`,
      to: recipient,
      subject: `${roles.length} New Executive Role${roles.length > 1 ? "s" : ""} Matched Today`,
      html: buildHtml(roles),
    });
    return res.status(200).json({ success: true, messageId: info.messageId, recipient });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function buildHtml(roles) {
  const bg = "#0d0f14";
  const surface = "#13161e";
  const card = "#1a1d28";
  const border = "#272b3a";
  const accent = "#c9a84c";
  const blue = "#5b8dee";
  const muted = "#7a7f96";
  const text = "#e8e3d8";

  const roleCards = roles
    .map(
      (r) => `
    <div style="background:${card};border:1px solid ${border};border-radius:8px;padding:16px;margin-bottom:12px;">
      <div style="font-size:15px;font-weight:600;color:${text};margin-bottom:6px;">${esc(r.Title || "Untitled Role")}</div>
      <div style="font-size:12px;color:${muted};margin-bottom:${r.Summary ? "10px" : "0"};">
        ${[r.Company, r.Location, r.Salary, r.Source].filter(Boolean).map(esc).join(" &middot; ")}
      </div>
      ${r.Summary ? `<div style="font-size:13px;color:#b8b3a8;line-height:1.65;margin-bottom:10px;">${esc(r.Summary.slice(0, 220))}${r.Summary.length > 220 ? "…" : ""}</div>` : ""}
      ${r.URL ? `<a href="${r.URL}" style="font-size:12px;color:${blue};text-decoration:none;">View Posting →</a>` : ""}
    </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:${bg};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px;">
    <div style="border-bottom:1px solid ${border};padding-bottom:20px;margin-bottom:24px;">
      <div style="font-size:22px;font-weight:700;color:${accent};margin-bottom:2px;">Executive Search Agent</div>
      <div style="font-size:13px;color:${muted};">
        ${roles.length} new role${roles.length > 1 ? "s" : ""} matched your profile today
      </div>
    </div>

    ${roleCards}

    <div style="margin-top:28px;padding-top:16px;border-top:1px solid ${border};font-size:11px;color:${muted};line-height:1.8;">
      Sent by Executive Job Search Agent &nbsp;&middot;&nbsp;
      <a href="https://executive-job-search.vercel.app" style="color:${accent};text-decoration:none;">Open Pipeline</a>
    </div>
  </div>
</body>
</html>`;
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
