import { NextResponse } from "next/server";
import { fetchNasionalResults } from "@/lib/aggregator";

export const dynamic = "force-dynamic";

const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{3,39}$/;
function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const candidate = forwarded ? forwarded.split(",")[0].trim() : "";
  if (candidate && IP_REGEX.test(candidate)) return candidate;
  return "unknown";
}

const refreshRateLimit = new Map<string, number>();
const REFRESH_COOLDOWN_MS = 30 * 1000;
const MAX_RL_ENTRIES = 5_000;

const globalRateLimit = new Map<string, { count: number; windowStart: number }>();
const GLOBAL_LIMIT = 30;
const GLOBAL_WINDOW_MS = 60_000;
const MAX_GLOBAL_RL_ENTRIES = 10_000;

function checkGlobalRateLimit(ip: string): boolean {
  const now = Date.now();

  if (globalRateLimit.size > MAX_GLOBAL_RL_ENTRIES) {
    for (const [key, val] of globalRateLimit.entries()) {
      if (now - val.windowStart > GLOBAL_WINDOW_MS) globalRateLimit.delete(key);
    }
  }

  const entry = globalRateLimit.get(ip);
  if (!entry || now - entry.windowStart > GLOBAL_WINDOW_MS) {
    globalRateLimit.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= GLOBAL_LIMIT) return false;
  entry.count++;
  return true;
}

function cleanupRefreshRateLimit() {
  if (refreshRateLimit.size <= MAX_RL_ENTRIES) return;
  const now = Date.now();
  for (const [ip, ts] of refreshRateLimit.entries()) {
    if (now - ts > REFRESH_COOLDOWN_MS) refreshRateLimit.delete(ip);
  }
  if (refreshRateLimit.size > MAX_RL_ENTRIES) {
    const toDelete = [...refreshRateLimit.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, refreshRateLimit.size - MAX_RL_ENTRIES);
    for (const [ip] of toDelete) refreshRateLimit.delete(ip);
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh   = searchParams.get("refresh") === "1";
    const provinsiFilter = searchParams.get("provinsi");

    const clientIp = getClientIp(request);
    if (!checkGlobalRateLimit(clientIp)) {
      return NextResponse.json(
        { success: false, message: "Terlalu banyak permintaan. Coba lagi dalam 1 menit." },
        {
          status: 429,
          headers: {
            "Retry-After": "60",
            "X-RateLimit-Limit": String(GLOBAL_LIMIT),
          },
        }
      );
    }

    if (forceRefresh) {
      const ip = getClientIp(request);
      if (ip === "unknown") {
        return NextResponse.json(
          { success: false, message: "Permintaan tidak dapat diidentifikasi." },
          { status: 403 }
        );
      }
      const lastRefresh = refreshRateLimit.get(ip) || 0;
      if (Date.now() - lastRefresh < REFRESH_COOLDOWN_MS) {
        return NextResponse.json(
          { success: false, message: "Terlalu sering refresh. Tunggu 30 detik." },
          { status: 429 }
        );
      }
      cleanupRefreshRateLimit();
      refreshRateLimit.set(ip, Date.now());
    }

    const data = await fetchNasionalResults(forceRefresh);

    if (provinsiFilter) {
      if (provinsiFilter.length > 100) {
        return NextResponse.json(
          { success: false, message: "Filter provinsi tidak valid. Terlalu panjang." },
          { status: 400 }
        );
      }

      const provinsiData = data.byProvinsi.find(
        p => p.provinsi.toLowerCase() === provinsiFilter.toLowerCase()
      );
      if (!provinsiData) {
        return NextResponse.json({ success: false, message: "Provinsi tidak ditemukan." }, { status: 404 });
      }
      return NextResponse.json({ success: true, provinsi: provinsiData, lastUpdated: data.lastUpdated });
    }

    return NextResponse.json({ success: true, ...data });

  } catch (error: unknown) {
    console.error("Results API Error:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { success: false, message: "Terjadi kesalahan saat mengambil data. Silakan coba lagi." },
      { status: 500 }
    );
  }
}
