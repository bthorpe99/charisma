const ALLOWED_ORIGIN = "https://trycharisma.live";
const DAILY_API = "https://api.daily.co/v1";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Cache-Control": "no-store"
    }
  });
}

async function dailyRequest(path, apiKey, init = {}) {
  const response = await fetch(`${DAILY_API}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.info || data.error || "Daily request failed");
  return data;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return json({ok: false, error: "Method not allowed"}, 405);
    if (!env.DAILY_API_KEY || !env.CHARISMA_WORKER_SECRET) return json({ok: false, error: "Worker is not configured"}, 503);
    if (request.headers.get("Authorization") !== `Bearer ${env.CHARISMA_WORKER_SECRET}`) {
      return json({ok: false, error: "Unauthorized"}, 401);
    }

    try {
      const body = await request.json();
      const room = String(body.room || "").trim();
      if (!/^charisma-[a-z0-9-]{8,80}$/.test(room)) return json({ok: false, error: "Invalid room"}, 400);

      const exp = Math.floor(Date.now() / 1000) + 20 * 60;
      const created = await dailyRequest("/rooms", env.DAILY_API_KEY, {
        method: "POST",
        body: JSON.stringify({
          name: room,
          privacy: "private",
          properties: {
            exp,
            eject_at_room_exp: true,
            enable_chat: false,
            enable_people_ui: false,
            start_video_off: false,
            start_audio_off: false
          }
        })
      });

      const tokens = await Promise.all([0, 1].map(() => dailyRequest("/meeting-tokens", env.DAILY_API_KEY, {
        method: "POST",
        body: JSON.stringify({properties: {room_name: room, exp, is_owner: false}})
      })));
      const baseUrl = created.url || `https://trycharisma.daily.co/${room}`;
      return json({ok: true, urls: tokens.map(item => `${baseUrl}?t=${encodeURIComponent(item.token)}`)});
    } catch (error) {
      return json({ok: false, error: "Room creation failed"}, 502);
    }
  }
};
