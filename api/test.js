export default function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  res.json({
    hasKey: !!key,
    keyLength: key ? key.length : 0,
    keyStart: key ? key.substring(0, 10) : "none",
  });
}
