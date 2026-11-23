// netlify/functions/digest.js
// Scheduled: emails the Monday digest to the team at 8:00 a.m. Central.
// netlify.toml runs this at 13:00 and 14:00 UTC on Mondays (8:00 Central in summer and in winter);
// the time check below makes sure only one of those two runs sends.
// To send one by hand, use "Monday digest" on the Team board in the Task Hub.

const { googleReady } = require("../lib/google");
const { sendDigest } = require("../lib/digest");

exports.handler = async () => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", hour12: false })
      .formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  if (parts.weekday !== "Mon" || Number(parts.hour) !== 8) {
    console.log(`Digest skipped: it's ${parts.weekday} ${parts.hour}:00 in Central time.`);
    return { statusCode: 200 };
  }
  if (!googleReady()) {
    console.error("Digest not sent: the Google connection isn't set up.");
    return { statusCode: 200 };
  }
  try {
    const r = await sendDigest();
    console.log(`Digest sent to ${r.sentTo.length} people: ${r.subject}`);
  } catch (err) {
    console.error(`Digest failed: ${err.message}`);
  }
  return { statusCode: 200 };
};
