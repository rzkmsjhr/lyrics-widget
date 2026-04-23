import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toRomaji } from "wanakana";
import kuromoji from "kuromoji";

// ── Lyric sync offset ──────────────────────────────────────────────────────
const LYRIC_OFFSET_MS = 600;

// ── Resize handle ──────────────────────────────────────────────────────────
type ResizeDir =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

const ResizeHandle = ({ dir, style }: { dir: ResizeDir; style: React.CSSProperties }) => (
  <div
    style={{ position: "absolute", zIndex: 9999, ...style }}
    onMouseDown={(e) => {
      e.preventDefault();
      e.stopPropagation();
      getCurrentWindow().startResizeDragging(dir);
    }}
  />
);

// ── Kuromoji (Japanese tokenizer) ─────────────────────────────────────────
// Loads the dictionary once (~10 MB) on first Japanese song, then stays ready.
type KuromojiTokenizer = kuromoji.Tokenizer<kuromoji.IpadicFeatures>;
let tokenizerPromise: Promise<KuromojiTokenizer> | null = null;

function getTokenizer(): Promise<KuromojiTokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      console.log("[kuromoji] Starting dictionary load from /kuromoji/dict/...");
      kuromoji.builder({ dicPath: "/kuromoji/dict/" }).build((err, tokenizer) => {
        if (err) {
          console.error("[kuromoji] Dictionary load FAILED:", err);
          reject(err);
        } else {
          console.log("[kuromoji] Dictionary loaded successfully!");
          resolve(tokenizer);
        }
      });
    });
  }
  return tokenizerPromise;
}

/** Convert a Japanese text to romaji using kuromoji (for kanji) + wanakana (for kana) */
async function romanizeJapanese(text: string): Promise<string> {
  const tokenizer = await getTokenizer();
  return tokenizer
    .tokenize(text)
    .map((t) => toRomaji(t.reading ?? t.surface_form))
    .join("");
}

// ── Korean romanization ────────────────────────────────────────────────────
function romanizeKorean(text: string): string {
  const INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
  const VOWELS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
  const FINALS = ["", "k", "kk", "ks", "n", "nj", "nh", "t", "l", "lk", "lm", "lb", "ls", "lt", "lp", "lh", "m", "b", "bs", "s", "ss", "ng", "j", "ch", "k", "t", "p", "h"];
  return text
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code >= 0xac00 && code <= 0xd7a3) {
        const syl = code - 0xac00;
        const fin = syl % 28;
        const vow = Math.floor(syl / 28) % 21;
        const init = Math.floor(syl / 28 / 21);
        return INITIALS[init] + VOWELS[vow] + FINALS[fin];
      }
      return char;
    })
    .join("");
}

// ── Script detection ───────────────────────────────────────────────────────
function detectScript(text: string): "korean" | "japanese" | "none" {
  const k = (text.match(/[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g) || []).length;
  const j = (text.match(/[\u3040-\u30FF\u4E00-\u9FFF]/g) || []).length; // kana + CJK kanji
  if (k > j && k > 0) return "korean";
  if (j > 0) return "japanese";
  return "none";
}
// ──────────────────────────────────────────────────────────────────────────

interface TrackInfo { title: string; artist: string; progress_ms: number; }
interface LyricLine { time: number; text: string; }

function App() {
  const [currentLyric, setCurrentLyric] = useState("Waiting for Spotify...");
  const [currentRomajiLyric, setCurrentRomajiLyric] = useState("");
  const [showRomaji, setShowRomaji] = useState(false);
  const [scriptType, setScriptType] = useState<"korean" | "japanese" | "none">("none");

  // Refs don't cause re-renders — safe to read inside setInterval closures
  const currentTrackKeyRef = useRef<string | null>(null);
  const lyricsRef = useRef<LyricLine[]>([]); // original
  const lyricsRomajiRef = useRef<LyricLine[]>([]); // pre-romanized
  const showRomajiRef = useRef(false);           // mirrors showRomaji state
  const baseProgressRef = useRef<number>(0);
  const baseTimeRef = useRef<number>(Date.now());
  const lastSmtcProgressRef = useRef<number>(-1);
  const isPlayingRef = useRef<boolean>(false);

  // Warm up the kuromoji tokenizer early so it's ready on first Japanese song
  useEffect(() => { getTokenizer().catch(() => { }); }, []);

  useEffect(() => {
    // ── Fetch lyrics ───────────────────────────────────────────────────────
    const fetchLyrics = async (trackName: string, artistName: string) => {
      try {
        const cleanTrack = trackName.replace(/ \(.+\)| -.+/g, "");
        const res = await fetch(
          `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTrack)}&artist_name=${encodeURIComponent(artistName)}`
        );
        if (!res.ok) throw new Error("Not found");
        const data = await res.json();

        if (data?.syncedLyrics) {
          const regex = /^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;
          const parsed: LyricLine[] = data.syncedLyrics
            .split("\n")
            .map((line: string) => {
              const match = line.match(regex);
              if (!match) return null;
              const m = parseInt(match[1]);
              const s = parseInt(match[2]);
              const ms = match[3].length === 2 ? parseInt(match[3]) * 10 : parseInt(match[3]);
              return (match[4].trim()) ? { time: m * 60_000 + s * 1000 + ms, text: match[4].trim() } : null;
            })
            .filter(Boolean) as LyricLine[];

          lyricsRef.current = parsed;
          lyricsRomajiRef.current = [];

          // Detect script from the first few non-empty lines
          const sample = parsed.slice(0, 5).map(l => l.text).join(" ");
          const script = detectScript(sample);
          setScriptType(script);

          if (script === "korean") {
            // Korean romanization is synchronous — do it immediately
            lyricsRomajiRef.current = parsed.map(l => ({ time: l.time, text: romanizeKorean(l.text) }));
          } else if (script === "japanese") {
            // Japanese needs kuromoji dictionary — run in background
            romanizeAllLines(parsed).then(romanized => {
              lyricsRomajiRef.current = romanized;
            });
          }
        } else {
          lyricsRef.current = [];
          lyricsRomajiRef.current = [];
          setScriptType("none");
          setCurrentLyric(`🎵 ${trackName}`);
        }
      } catch {
        lyricsRef.current = [];
        lyricsRomajiRef.current = [];
        setScriptType("none");
        setCurrentLyric(`🎵 ${trackName}`);
      }
    };

    // ── SMTC Poll (1 s) ───────────────────────────────────────────────────
    const pollSMTC = async () => {
      try {
        const track = await invoke<TrackInfo | null>("get_current_track");

        if (!track) {
          isPlayingRef.current = false;
          if (currentTrackKeyRef.current !== null) {
            currentTrackKeyRef.current = null;
            lyricsRef.current = [];
            lyricsRomajiRef.current = [];
            setScriptType("none");
            setCurrentLyric("▶ Play a song on Spotify...");
          }
          return;
        }

        isPlayingRef.current = true;
        const trackKey = `${track.title}::${track.artist}`;

        if (currentTrackKeyRef.current !== trackKey) {
          currentTrackKeyRef.current = trackKey;
          lyricsRef.current = [];
          lyricsRomajiRef.current = [];
          lastSmtcProgressRef.current = track.progress_ms;
          baseProgressRef.current = track.progress_ms;
          baseTimeRef.current = Date.now();
          setCurrentLyric("Loading lyrics...");
          await fetchLyrics(track.title, track.artist);
        } else {
          const smtcProgress = track.progress_ms;
          const prevSmtc = lastSmtcProgressRef.current;
          lastSmtcProgressRef.current = smtcProgress;

          if (smtcProgress !== prevSmtc) {
            const localEstimate = baseProgressRef.current + (Date.now() - baseTimeRef.current);
            if (Math.abs(smtcProgress - localEstimate) > 2000) {
              baseProgressRef.current = smtcProgress;
              baseTimeRef.current = Date.now();
            }
          }
        }
      } catch (err) {
        console.error("SMTC poll error:", err);
      }
    };

    // ── Lyric ticker (250 ms) ─────────────────────────────────────────────
    const updateLyric = () => {
      if (!isPlayingRef.current || lyricsRef.current.length === 0) return;

      const progress = baseProgressRef.current + (Date.now() - baseTimeRef.current) + LYRIC_OFFSET_MS;
      const lyrics = lyricsRef.current;

      // Find active index using the original lyrics array
      let activeIdx = 0;
      for (let i = 0; i < lyrics.length; i++) {
        if (progress >= lyrics[i].time) activeIdx = i;
        else break;
      }

      setCurrentLyric(lyrics[activeIdx].text);

      // Mirror the same index into the romaji array (always in sync)
      const romaji = lyricsRomajiRef.current;
      if (romaji.length > 0 && activeIdx < romaji.length) {
        setCurrentRomajiLyric(romaji[activeIdx].text);
      }
    };

    pollSMTC();
    const smtcId = setInterval(pollSMTC, 1000);
    const lyricId = setInterval(updateLyric, 250);
    return () => { clearInterval(smtcId); clearInterval(lyricId); };
  }, []);

  const toggleRomaji = () => {
    const next = !showRomajiRef.current;
    showRomajiRef.current = next;
    setShowRomaji(next);
  };

  const EDGE = 6;
  const CORN = 12;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>

      {/* Resize handles */}
      <ResizeHandle dir="North" style={{ top: 0, left: CORN, right: CORN, height: EDGE, cursor: "n-resize" }} />
      <ResizeHandle dir="South" style={{ bottom: 0, left: CORN, right: CORN, height: EDGE, cursor: "s-resize" }} />
      <ResizeHandle dir="East" style={{ right: 0, top: CORN, bottom: CORN, width: EDGE, cursor: "e-resize" }} />
      <ResizeHandle dir="West" style={{ left: 0, top: CORN, bottom: CORN, width: EDGE, cursor: "w-resize" }} />
      <ResizeHandle dir="NorthWest" style={{ top: 0, left: 0, width: CORN, height: CORN, cursor: "nw-resize" }} />
      <ResizeHandle dir="NorthEast" style={{ top: 0, right: 0, width: CORN, height: CORN, cursor: "ne-resize" }} />
      <ResizeHandle dir="SouthWest" style={{ bottom: 0, left: 0, width: CORN, height: CORN, cursor: "sw-resize" }} />
      <ResizeHandle dir="SouthEast" style={{ bottom: 0, right: 0, width: CORN, height: CORN, cursor: "se-resize" }} />

      {/* Main drag region */}
      <main
        data-tauri-drag-region
        style={{ position: "absolute", inset: EDGE }}
        className="flex flex-col items-center justify-center bg-black/40 backdrop-blur-md rounded-2xl cursor-move select-none"
      >
        {/* Dual-line mode: original on top, romaji below */}
        {showRomaji && scriptType !== "none" ? (
          <div className="flex flex-col items-center gap-1 pointer-events-none px-6">
            {/* Original script */}
            <p
              className="text-xl font-bold text-white text-center leading-snug"
              style={{ textShadow: "0px 2px 4px rgba(0,0,0,0.9)" }}
            >
              {currentLyric}
            </p>
            {/* Romaji */}
            <p
              className="text-sm font-medium text-white/65 text-center leading-snug"
              style={{ textShadow: "0px 1px 3px rgba(0,0,0,0.8)" }}
            >
              {currentRomajiLyric || "..."}
            </p>
          </div>
        ) : (
          /* Single-line mode */
          <p
            className="text-2xl font-bold text-white text-center pointer-events-none px-6"
            style={{ textShadow: "0px 2px 4px rgba(0,0,0,0.8)" }}
          >
            {currentLyric}
          </p>
        )}

        {/* ROM toggle — only visible for Korean/Japanese lyrics */}
        {scriptType !== "none" && (
          <button
            onClick={toggleRomaji}
            title={showRomaji ? "Show original" : "Show romaji"}
            style={{ zIndex: 10 }}
            className={`
              absolute bottom-2 right-3 text-[10px] font-bold px-2 py-0.5 rounded-full
              border transition-all cursor-pointer
              ${showRomaji
                ? "bg-white/90 text-black border-white/80"
                : "bg-transparent text-white/50 border-white/20 hover:text-white/80 hover:border-white/40"}
            `}
          >
            ROM
          </button>
        )}
      </main>
    </div>
  );
}

/** Pre-romanize all lyric lines for a Japanese song (runs once per song) */
async function romanizeAllLines(lines: LyricLine[]): Promise<LyricLine[]> {
  try {
    const tokenizer = await getTokenizer();
    return lines.map(line => ({
      time: line.time,
      text: tokenizer
        .tokenize(line.text)
        .map(t => toRomaji(t.reading ?? t.surface_form))
        .join(""),
    }));
  } catch (err) {
    console.warn("[kuromoji] romanizeAllLines fell back to wanakana:", err);
    return lines.map(line => ({ time: line.time, text: toRomaji(line.text) }));
  }
}

export default App;