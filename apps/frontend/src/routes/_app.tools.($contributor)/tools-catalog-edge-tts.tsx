import { useState, useRef, useEffect, type ChangeEvent } from "react";
import { Play, Download, Volume2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiUrl } from "@/utils/utils.api-url";

const edgeTtsStyles = tv({
  slots: {
    container: "space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/50 p-4",
    row: "grid grid-cols-1 gap-3 sm:grid-cols-2",
    fieldGroup: "space-y-1.5",
    label:
      "font-mono text-[11px] font-semibold tracking-wider text-zinc-600 uppercase",
    select:
      "h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-xs text-zinc-800 transition-colors focus:border-zinc-500 focus:outline-none",
    sliderTrack: "flex items-center justify-between text-[11px] text-zinc-500",
    audioCard:
      "space-y-3 rounded-lg border border-zinc-200 bg-white p-3 shadow-xs",
  },
});

interface VoiceOption {
  id: string;
  name: string;
  sample: string;
}

const VOICES_BY_LANG: Record<string, VoiceOption[]> = {
  en: [
    {
      id: "en-US-AriaNeural",
      name: "Aria (Nữ · US)",
      sample: "The bus stop is located next to the main metro entrance.",
    },
    {
      id: "en-US-GuyNeural",
      name: "Guy (Nam · US)",
      sample: "Welcome to our learning platform. Let's start the lesson today.",
    },
    {
      id: "en-US-JennyNeural",
      name: "Jenny (Nữ · US)",
      sample: "Can you tell me how to get to Ben Thanh Market?",
    },
    {
      id: "en-US-ChristopherNeural",
      name: "Christopher (Nam · US)",
      sample: "Please review the documents before the meeting.",
    },
    {
      id: "en-US-EricNeural",
      name: "Eric (Nam · US)",
      sample: "Great job completing your daily language assignment.",
    },
    {
      id: "en-US-MichelleNeural",
      name: "Michelle (Nữ · US)",
      sample: "Listen carefully to the following dialogue.",
    },
    {
      id: "en-US-RogerNeural",
      name: "Roger (Nam · US)",
      sample: "Turn left at the next intersection and keep walking.",
    },
    {
      id: "en-GB-SoniaNeural",
      name: "Sonia (Nữ · UK)",
      sample: "Location four marks the bus stop east of the market.",
    },
    {
      id: "en-GB-RyanNeural",
      name: "Ryan (Nam · UK)",
      sample: "Please turn right at the corner opposite the square.",
    },
    {
      id: "en-GB-LibbyNeural",
      name: "Libby (Nữ · UK)",
      sample: "The local museum is open daily from nine to five.",
    },
    {
      id: "en-AU-NatashaNeural",
      name: "Natasha (Nữ · AU)",
      sample: "G'day! Welcome to your daily English pronunciation workout.",
    },
    {
      id: "en-AU-WilliamNeural",
      name: "William (Nam · AU)",
      sample: "Let's explore the highlights around town today.",
    },
    {
      id: "en-CA-ClaraNeural",
      name: "Clara (Nữ · CA)",
      sample: "Have a great day practicing your language skills.",
    },
    {
      id: "en-CA-LiamNeural",
      name: "Liam (Nam · CA)",
      sample: "Follow along with the speaker to practice your rhythm.",
    },
    {
      id: "en-IN-NeerjaNeural",
      name: "Neerja (Nữ · India)",
      sample: "Welcome to today's English pronunciation lesson.",
    },
    {
      id: "en-IN-PrabhatNeural",
      name: "Prabhat (Nam · India)",
      sample: "Please choose the correct option from the list below.",
    },
    {
      id: "en-IE-EmilyNeural",
      name: "Emily (Nữ · Ireland)",
      sample: "It is a pleasure to help you practice pronunciation.",
    },
    {
      id: "en-NZ-MitchellNeural",
      name: "Mitchell (Nam · New Zealand)",
      sample: "Kia ora! Let's get started on the first exercise.",
    },
    {
      id: "en-SG-LunaNeural",
      name: "Luna (Nữ · Singapore)",
      sample: "Good morning! Are you ready for your listening test?",
    },
    {
      id: "en-ZA-LeahNeural",
      name: "Leah (Nữ · South Africa)",
      sample: "Practice speaking each sentence clearly and smoothly.",
    },
  ],
  zh: [
    {
      id: "zh-CN-XiaoxiaoNeural",
      name: "Xiaoxiao (Nữ · Phổ thông)",
      sample: "你好！欢迎使用智能语音学习助手。",
    },
    {
      id: "zh-CN-YunxiNeural",
      name: "Yunxi (Nam · Phổ thông)",
      sample: "请在下面的地图中找出公交车站的位置。",
    },
    {
      id: "zh-CN-YunjianNeural",
      name: "Yunjian (Nam · Phổ thông)",
      sample: "本单元的重点是学习方向和交通路线。",
    },
    {
      id: "zh-CN-XiaoyiNeural",
      name: "Xiaoyi (Nữ · Phổ thông)",
      sample: "请仔细听录音，并回答接下来的问题。",
    },
    {
      id: "zh-CN-YunyangNeural",
      name: "Yunyang (Nam · Phổ thông)",
      sample: "祝大家在接下来的测试中取得优异成绩。",
    },
    {
      id: "zh-HK-HiuMaanNeural",
      name: "HiuMaan (Nữ · Quảng Đông)",
      sample: "你好，歡迎嚟到呢個語言學習系統。",
    },
    {
      id: "zh-HK-WanLungNeural",
      name: "WanLung (Nam · Quảng Đông)",
      sample: "巴士站位於地鐵站出口嘅旁邊。",
    },
    {
      id: "zh-TW-HsiaoChenNeural",
      name: "HsiaoChen (Nữ · Đài Loan)",
      sample: "很高興遇見你，讓我們一起開始學習吧。",
    },
    {
      id: "zh-TW-YunJheNeural",
      name: "YunJhe (Nam · Đài Loan)",
      sample: "請在方格中填入正確的生字與發音。",
    },
  ],
  ko: [
    {
      id: "ko-KR-SunHiNeural",
      name: "SunHi (Nữ · Hàn Quốc)",
      sample: "안녕하세요! 언어 학습 시스템에 오신 것을 환영합니다.",
    },
    {
      id: "ko-KR-InJoonNeural",
      name: "InJoon (Nam · Hàn Quốc)",
      sample: "오늘의 한국어 듣기 및 발음 연습을 시작해 보겠습니다.",
    },
  ],
  ja: [
    {
      id: "ja-JP-NanamiNeural",
      name: "Nanami (Nữ · Nhật Bản)",
      sample: "こんにちは！音声合成スタジオへようこそ。",
    },
    {
      id: "ja-JP-KeitaNeural",
      name: "Keita (Nam · Nhật Bản)",
      sample: "本日のリスニングと発音の練習を始めましょう。",
    },
  ],
  fr: [
    {
      id: "fr-FR-DeniseNeural",
      name: "Denise (Nữ · Pháp)",
      sample: "Bonjour! Bienvenue dans le studio de synthèse vocale.",
    },
    {
      id: "fr-FR-HenriNeural",
      name: "Henri (Nam · Pháp)",
      sample: "L'arrêt de bus se trouve juste à côté de l'entrée du métro.",
    },
    {
      id: "fr-FR-EloiseNeural",
      name: "Eloise (Nữ · Pháp)",
      sample: "Écoutez attentivement le dialogue suivant.",
    },
    {
      id: "fr-CA-SylvieNeural",
      name: "Sylvie (Nữ · Canada)",
      sample: "Passez une excellente journée à pratiquer vos compétences.",
    },
    {
      id: "fr-CA-AntoineNeural",
      name: "Antoine (Nam · Canada)",
      sample: "La gare centrale est accessible à pied depuis le centre-ville.",
    },
    {
      id: "fr-BE-CharlineNeural",
      name: "Charline (Nữ · Bỉ)",
      sample: "Bienvenue dans votre module d'apprentissage du français.",
    },
    {
      id: "fr-CH-ArianeNeural",
      name: "Ariane (Nữ · Thụy Sĩ)",
      sample: "Prenez le temps d'écouter chaque phrase avec attention.",
    },
  ],
  th: [
    {
      id: "th-TH-PremwadeeNeural",
      name: "Premwadee (Nữ · Thái Lan)",
      sample: "สวัสดีค่ะ ยินดีต้อนรับสู่ระบบฝึกออกเสียง",
    },
    {
      id: "th-TH-NiwatNeural",
      name: "Niwat (Nam · Thái Lan)",
      sample: "ป้ายรถประจำทางตั้งอยู่ติดกับทางเข้าสถานีรถไฟฟ้า",
    },
  ],
  es: [
    {
      id: "es-ES-ElviraNeural",
      name: "Elvira (Nữ · Tây Ban Nha)",
      sample: "¡Hola! Bienvenidos a nuestra plataforma de aprendizaje.",
    },
    {
      id: "es-ES-AlvaroNeural",
      name: "Alvaro (Nam · Tây Ban Nha)",
      sample: "La parada de autobús está situada junto a la entrada del metro.",
    },
    {
      id: "es-MX-DaliaNeural",
      name: "Dalia (Nữ · Mexico)",
      sample: "Que tengas un excelente día practicando tu pronunciación.",
    },
    {
      id: "es-MX-JorgeNeural",
      name: "Jorge (Nam · Mexico)",
      sample: "Escucha con atención la siguiente conversación.",
    },
    {
      id: "es-US-PalomaNeural",
      name: "Paloma (Nữ · US)",
      sample: "La estación de tren se encuentra a dos calles del parque.",
    },
    {
      id: "es-US-AlonsoNeural",
      name: "Alonso (Nam · US)",
      sample: "Continúa practicando todos los días para mejorar tu acento.",
    },
    {
      id: "es-AR-ElenaNeural",
      name: "Elena (Nữ · Argentina)",
      sample: "¿Cómo estás? Empecemos con la práctica de pronunciación.",
    },
    {
      id: "es-CO-SalomeNeural",
      name: "Salome (Nữ · Colombia)",
      sample: "Bienvenidos al ejercicio de comprensión auditiva de hoy.",
    },
  ],
};

type SupportedLang = "en" | "zh" | "ko" | "ja" | "fr" | "th" | "es";

export default function ToolsCatalogEdgeTts() {
  const styles = edgeTtsStyles();
  const [lang, setLang] = useState<SupportedLang>("en");
  const [voice, setVoice] = useState(VOICES_BY_LANG.en[0].id);
  const [rate, setRate] = useState(1.0);
  const [pitch, setPitch] = useState(0);
  const [text, setText] = useState(VOICES_BY_LANG.en[0].sample);
  const [generating, setGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const voices = VOICES_BY_LANG[lang] ?? [];

  useEffect(() => {
    if (audioUrl && audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play().catch((err) => {
        console.warn("Autoplay was prevented:", err);
      });
    }

    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  function handleLangChange(e: ChangeEvent<HTMLSelectElement>) {
    const nextLang = e.target.value as SupportedLang;
    setLang(nextLang);
    const firstVoice = VOICES_BY_LANG[nextLang]?.[0];
    if (firstVoice) {
      setVoice(firstVoice.id);
      setText(firstVoice.sample);
    }
  }

  async function handleGenerate() {
    if (!text.trim()) return;

    setGenerating(true);

    try {
      const response = await fetch(apiUrl("/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice,
          rate: `${Math.round((rate - 1.0) * 100)}%`,
          pitch: `${pitch}Hz`,
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(
          errorData.message ||
            `Lỗi máy chủ (${response.status} ${response.statusText})`,
        );
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
    } catch (err) {
      setAudioUrl(null);
      toast.error(
        err instanceof Error ? err.message : "Tạo giọng đọc thất bại.",
      );
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className={styles.container()}>
      <div className={styles.row()}>
        <div className={styles.fieldGroup()}>
          <label htmlFor="tts-lang" className={styles.label()}>
            Language
          </label>
          <select
            id="tts-lang"
            value={lang}
            onChange={handleLangChange}
            className={styles.select()}
          >
            <option value="en">English</option>
            <option value="zh">Chinese</option>
            <option value="ko">Korean</option>
            <option value="ja">Japanese</option>
            <option value="fr">French</option>
            <option value="th">Thai</option>
            <option value="es">Spanish</option>
          </select>
        </div>

        <div className={styles.fieldGroup()}>
          <label htmlFor="tts-voice" className={styles.label()}>
            Accent
          </label>
          <select
            id="tts-voice"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            className={styles.select()}
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.row()}>
        <div className={styles.fieldGroup()}>
          <div className={styles.sliderTrack()}>
            <span className={styles.label()}>Speed</span>
            <span>{rate.toFixed(1)}x</span>
          </div>
          <input
            type="range"
            min="0.6"
            max="1.5"
            step="0.05"
            value={rate}
            onChange={(e) => setRate(parseFloat(e.target.value))}
            className="w-full accent-zinc-800"
          />
        </div>

        <div className={styles.fieldGroup()}>
          <div className={styles.sliderTrack()}>
            <span className={styles.label()}>Pitch</span>
            <span>{pitch}Hz</span>
          </div>
          <input
            type="range"
            min="-20"
            max="20"
            step="2"
            value={pitch}
            onChange={(e) => setPitch(parseInt(e.target.value, 10))}
            className="w-full accent-zinc-800"
          />
        </div>
      </div>

      <div className={styles.fieldGroup()}>
        <div className="flex items-center justify-between">
          <label htmlFor="tts-text" className={styles.label()}>
            Text content
          </label>
          <span className="font-mono text-[10px] text-zinc-400">
            {text.length} chars
          </span>
        </div>
        <Textarea
          id="tts-text"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste or type text to convert into speech..."
          className="max-h-45 overflow-y-auto bg-white text-xs"
        />
      </div>

      <div className="pt-1">
        <Button
          type="button"
          onClick={handleGenerate}
          disabled={generating || !text.trim()}
          className="w-full gap-2"
        >
          {generating ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Generating audio...
            </>
          ) : (
            <>
              <Play className="size-3.5" />
              Generate & Play
            </>
          )}
        </Button>
      </div>

      {audioUrl && (
        <div className={styles.audioCard()}>
          <Flex className="items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 font-medium text-emerald-600">
              <Volume2 className="size-3.5" />
              Audio ready
            </span>

            <a
              href={audioUrl}
              download="speech.mp3"
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-xs transition-colors hover:bg-zinc-50"
            >
              <Download className="size-3.5" />
              Download .mp3
            </a>
          </Flex>

          <audio
            ref={audioRef}
            autoPlay
            controls
            src={audioUrl}
            className="w-full h-10"
          />
        </div>
      )}
    </div>
  );
}
