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
  const j = (text.match(/[\u3040-\u30FF\u4E00-\u9FFF]/g) || []).length;
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
  const [isDarkTheme, setIsDarkTheme] = useState(true);
  const [isScrollMode, setIsScrollMode] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const currentTrackKeyRef = useRef<string | null>(null);
  const lyricsRef = useRef<LyricLine[]>([]);
  const lyricsRomajiRef = useRef<LyricLine[]>([]);
  const showRomajiRef = useRef(false);
  const baseProgressRef = useRef<number>(0);
  const baseTimeRef = useRef<number>(Date.now());
  const lastSmtcProgressRef = useRef<number>(-1);
  const isPlayingRef = useRef<boolean>(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => { getTokenizer().catch(() => { }); }, []);

  useEffect(() => {
    if (isScrollMode && activeLineRef.current) {
      activeLineRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [activeIndex, isScrollMode]);

  useEffect(() => {
    const fetchLyrics = async (trackName: string, artistName: string) => {
      try {
        let cleanTrack = trackName.replace(/\s*[\(\[](feat\.|ft\.|with).*?[\)\]]/gi, "");
        cleanTrack = cleanTrack.replace(/\s*-\s*(Remastered|Radio Edit|Live|Mono).*$/gi, "");
        let data = null;
        const res = await fetch(
          `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTrack)}&artist_name=${encodeURIComponent(artistName)}`
        );

        if (res.ok) {
          data = await res.json();
        }

        if (!data || !data.syncedLyrics) {
          console.log("Exact match failed, deploying global fuzzy net...");
          const firstWordOfArtist = artistName.trim().split(/\s+/)[0];
          const searchRes = await fetch(
            `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTrack + " " + firstWordOfArtist)}`
          );

          if (searchRes.ok) {
            const searchResults = await searchRes.json();
            const bestMatch = searchResults.find((result: any) => {
              if (!result.syncedLyrics) return false;

              const apiArtist = result.artistName.toLowerCase();
              const localArtist = artistName.toLowerCase();
              const apiArtistsArray = apiArtist.split(/,|&/).map((a: string) => a.trim());
              return apiArtistsArray.some((a: string) => localArtist.includes(a));
            });

            if (bestMatch) {
              data = bestMatch;
            } else {
              throw new Error("No matching artist found in search results");
            }
          }
        }

        if (data && data.syncedLyrics) {
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

          const sample = parsed.slice(0, 5).map((l: any) => l.text).join(" ");
          const script = detectScript(sample);
          setScriptType(script);

          if (script === "korean") {
            lyricsRomajiRef.current = parsed.map((l: any) => ({ time: l.time, text: romanizeKorean(l.text) }));
          } else if (script === "japanese") {
            romanizeAllLines(parsed).then(romanized => {
              lyricsRomajiRef.current = romanized;
            });
          }
        } else {
          throw new Error("No synced lyrics available after all fallback attempts");
        }
      } catch (err) {
        console.warn("Lyric fetch failed:", err);
        lyricsRef.current = [];
        lyricsRomajiRef.current = [];
        setScriptType("none");
        setCurrentLyric(`🎵 ${trackName}`);
      }
    };

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

    const updateLyric = () => {
      if (!isPlayingRef.current || lyricsRef.current.length === 0) return;

      const progress = baseProgressRef.current + (Date.now() - baseTimeRef.current) + LYRIC_OFFSET_MS;
      const lyrics = lyricsRef.current;

      let activeIdx = 0;
      for (let i = 0; i < lyrics.length; i++) {
        if (progress >= lyrics[i].time) activeIdx = i;
        else break;
      }

      setActiveIndex(activeIdx);
      setCurrentLyric(lyrics[activeIdx].text);

      const romaji = lyricsRomajiRef.current;
      if (romaji.length > 0 && activeIdx < romaji.length) {
        setCurrentRomajiLyric(romaji[activeIdx].text);
      }
    };

    pollSMTC();
    const smtcId = setInterval(pollSMTC, 1000);
    const lyricId = setInterval(updateLyric, 250);
    return () => { clearInterval(smtcId); clearInterval(lyricId); };
  }, [isScrollMode]);

  const toggleRomaji = () => {
    const next = !showRomajiRef.current;
    showRomajiRef.current = next;
    setShowRomaji(next);
  };

  const EDGE = 6;
  const CORN = 12;

  const bgColor = isDarkTheme ? "bg-black/40" : "bg-white/85";
  const mainTextColor = isDarkTheme ? "text-white" : "text-black";

  const subTextColor = isDarkTheme ? "text-white/65" : "text-black/80";

  const mainTextShadow = isDarkTheme
    ? "0px 2px 4px rgba(0,0,0,0.9)"
    : "0px 2px 6px rgba(255,255,255,1)";
  const subTextShadow = isDarkTheme
    ? "0px 1px 3px rgba(0,0,0,0.8)"
    : "0px 1px 4px rgba(255,255,255,1)";

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <ResizeHandle dir="North" style={{ top: 0, left: CORN, right: CORN, height: EDGE, cursor: "n-resize" }} />
      <ResizeHandle dir="South" style={{ bottom: 0, left: CORN, right: CORN, height: EDGE, cursor: "s-resize" }} />
      <ResizeHandle dir="East" style={{ right: 0, top: CORN, bottom: CORN, width: EDGE, cursor: "e-resize" }} />
      <ResizeHandle dir="West" style={{ left: 0, top: CORN, bottom: CORN, width: EDGE, cursor: "w-resize" }} />
      <ResizeHandle dir="NorthWest" style={{ top: 0, left: 0, width: CORN, height: CORN, cursor: "nw-resize" }} />
      <ResizeHandle dir="NorthEast" style={{ top: 0, right: 0, width: CORN, height: CORN, cursor: "ne-resize" }} />
      <ResizeHandle dir="SouthWest" style={{ bottom: 0, left: 0, width: CORN, height: CORN, cursor: "sw-resize" }} />
      <ResizeHandle dir="SouthEast" style={{ bottom: 0, right: 0, width: CORN, height: CORN, cursor: "se-resize" }} />

      <main
        data-tauri-drag-region
        style={{ position: "absolute", inset: EDGE }}
        className={`flex flex-col items-center justify-center backdrop-blur-md rounded-2xl cursor-move select-none overflow-hidden transition-colors duration-300 ${bgColor}`}
      >
        {isScrollMode && lyricsRef.current.length > 0 ? (
          /* Apple Music style scroll mode */
          <div 
            ref={scrollContainerRef}
            data-tauri-drag-region
            className="w-full h-full overflow-y-auto overflow-x-hidden scroll-smooth flex flex-col px-8 py-[40%] no-scrollbar"
            style={{ 
              maskImage: 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
              WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)'
            }}
          >
            {lyricsRef.current.map((line, idx) => {
              const isActive = idx === activeIndex;
              const romaji = lyricsRomajiRef.current[idx]?.text;
              return (
                <div
                  key={idx}
                  ref={isActive ? activeLineRef : null}
                  data-tauri-drag-region
                  className={`
                    py-4 transition-all duration-500 origin-left cursor-default
                    ${isActive ? "opacity-100 scale-105" : "opacity-30 scale-100 blur-[0.5px]"}
                  `}
                >
                  <p 
                    data-tauri-drag-region
                    className={`font-bold leading-tight ${mainTextColor}`}
                    style={{ 
                      fontSize: "clamp(1.2rem, 4vw, 2.5rem)",
                      textShadow: isActive ? mainTextShadow : "none"
                    }}
                  >
                    {line.text}
                  </p>
                  {showRomaji && romaji && (
                    <p 
                      data-tauri-drag-region
                      className={`font-semibold mt-1 ${subTextColor}`}
                      style={{ 
                        fontSize: "clamp(0.9rem, 3vw, 1.8rem)",
                        textShadow: isActive ? subTextShadow : "none"
                      }}
                    >
                      {romaji}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* Classic mode (Single/Dual line) */
          <div data-tauri-drag-region className="flex flex-col items-center justify-center h-full w-full">
            {showRomaji && scriptType !== "none" ? (
              <div data-tauri-drag-region className="flex flex-col items-center gap-1 pointer-events-none w-full">
                <p
                  data-tauri-drag-region
                  className={`font-bold text-center leading-snug w-full px-6 transition-colors duration-300 ${mainTextColor}`}
                  style={{
                    textShadow: mainTextShadow,
                    fontSize: "clamp(1.1rem, min(5.5vw, 18vh), 4.5rem)"
                  }}
                >
                  {currentLyric}
                </p>
                <p
                  data-tauri-drag-region
                  className={`font-semibold text-center leading-snug w-full px-6 transition-colors duration-300 ${subTextColor}`}
                  style={{
                    textShadow: subTextShadow,
                    fontSize: "clamp(0.85rem, min(4vw, 12vh), 3.5rem)"
                  }}
                >
                  {currentRomajiLyric || "..."}
                </p>
              </div>
            ) : (
              <p
                data-tauri-drag-region
                className={`font-bold text-center pointer-events-none w-full px-6 transition-colors duration-300 ${mainTextColor}`}
                style={{
                  textShadow: mainTextShadow,
                  fontSize: "clamp(1.25rem, min(6vw, 25vh), 5rem)"
                }}
              >
                {currentLyric}
              </p>
            )}
          </div>
        )}

        {/* --- Controls --- */}
        <div className="absolute bottom-2 left-3 flex items-center gap-2" style={{ zIndex: 10 }}>
          {/* Theme Toggle Button */}
          <button
            onClick={() => setIsDarkTheme(!isDarkTheme)}
            title={isDarkTheme ? "Switch to light theme" : "Switch to dark theme"}
            className={`
              text-[12px] px-2 py-0.5 rounded-full
              border transition-all cursor-pointer flex items-center justify-center
              ${isDarkTheme
                ? "bg-transparent text-white/50 border-white/20 hover:text-white/80 hover:border-white/40"
                : "bg-transparent text-black/50 border-black/30 hover:text-black/80 hover:border-black/50"}
            `}
          >
            {isDarkTheme ? "☀" : "☾"}
          </button>

          {/* Scroll Mode Toggle */}
          <button
            onClick={() => setIsScrollMode(!isScrollMode)}
            title={isScrollMode ? "Switch to single line" : "Switch to auto-scroll"}
            className={`
              text-[10px] font-bold px-2 py-0.5 rounded-full border transition-all cursor-pointer
              ${isScrollMode
                ? (isDarkTheme ? "bg-white/90 text-black border-white/80" : "bg-black/80 text-white border-black/80")
                : (isDarkTheme ? "bg-transparent text-white/50 border-white/20 hover:text-white/80 hover:border-white/40"
                  : "bg-transparent text-black/50 border-black/30 hover:text-black/80 hover:border-black/50")}
            `}
          >
            LIST
          </button>
        </div>

        {/* ROM toggle */}
        {scriptType !== "none" && (
          <button
            onClick={toggleRomaji}
            title={showRomaji ? "Show original" : "Show romaji"}
            style={{ zIndex: 10 }}
            className={`
              absolute bottom-2 right-3 text-[10px] font-bold px-2 py-0.5 rounded-full
              border transition-all cursor-pointer
              ${showRomaji
                ? (isDarkTheme ? "bg-white/90 text-black border-white/80" : "bg-black/80 text-white border-black/80")
                : (isDarkTheme ? "bg-transparent text-white/50 border-white/20 hover:text-white/80 hover:border-white/40"
                  : "bg-transparent text-black/50 border-black/30 hover:text-black/80 hover:border-black/50")}
            `}
          >
            ROM
          </button>
        )}
      </main>
    </div>
  );
}

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