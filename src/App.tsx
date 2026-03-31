/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";
import { Mic, MicOff, Play, Square, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Audio utilities for PCM processing
class AudioProcessor {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private sampleRate = 16000;

  async start(onAudioData: (base64Data: string) => void) {
    this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.source = this.audioContext.createMediaStreamSource(this.stream);

    const bufferSize = 4096;
    this.scriptNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    
    this.scriptNode.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const pcmData = this.float32ToInt16(inputData);
      const base64Data = this.arrayBufferToBase64(pcmData.buffer);
      onAudioData(base64Data);
    };

    this.source.connect(this.scriptNode);
    this.scriptNode.connect(this.audioContext.destination);
  }

  stop() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.scriptNode?.disconnect();
    this.source?.disconnect();
    this.audioContext?.close();
  }

  private float32ToInt16(buffer: Float32Array): Int16Array {
    const l = buffer.length;
    const buf = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      buf[i] = Math.min(1, Math.max(-1, buffer[i])) * 0x7FFF;
    }
    return buf;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }
}

class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private nextStartTime = 0;
  private sampleRate = 24000;

  constructor() {
    this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
    this.nextStartTime = this.audioContext.currentTime;
  }

  playChunk(base64Data: string) {
    if (!this.audioContext) return;

    const binary = window.atob(base64Data);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const pcmData = new Int16Array(bytes.buffer);
    const floatData = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      floatData[i] = pcmData[i] / 0x7FFF;
    }

    const audioBuffer = this.audioContext.createBuffer(1, floatData.length, this.sampleRate);
    audioBuffer.getChannelData(0).set(floatData);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const startTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
    source.start(startTime);
    this.nextStartTime = startTime + audioBuffer.duration;
  }

  stop() {
    this.audioContext?.close();
    this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
    this.nextStartTime = this.audioContext.currentTime;
  }
}

const SYSTEM_INSTRUCTION = `You are a professional voice agent for Carmén Merilaid. You speak English and French. Your tone is professional. You are helpful and provide information about Carmén's background, education, work experience, and skills based on her CV.
Carmén Merilaid is a Fashion Business student at ESMOD Paris, specializing in Marketing and Communications Strategy.
Work Experience:
- Paris Showroom Assistant at Tomorrow London (March 2025 - present): Styling, dressing models for Paris Fashion Week, organizing collections for buyers.
- Luxury Fragrance Consultant at Créme de la Créme / Internship (May 2025 - September 2025): Sales, olfactory training, client consulting.
- Sales Executive at Software Development Academy (May 2023 - October 2024): Managed 1.5M sales portfolio, generated 60% of total sales revenue in Estonia.
Education:
- ESMOD Paris - Bachelor Fashion Business (2024 - present).
- Estonian Business School - Entrepreneurship and Business Administration (2022 - 2024).
Skills: Google Analytics, Google Ads, SEO, Digital Performance, Sales, CRM, Adobe Suite (Illustrator, InDesign, Photoshop), Figma, Canva.
Languages: Estonian (C2), English (C1), French (B2), Russian (B1).
Start the conversation by saying exactly: 'hello, what would you like to know about Carmeń'.
Do not talk too slow. Use the voice 'Kore'.`;

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [transcription, setTranscription] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  
  const audioProcessorRef = useRef<AudioProcessor | null>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const sessionRef = useRef<any>(null);

  const startSession = async () => {
    setIsConnecting(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      audioProcessorRef.current = new AudioProcessor();
      audioPlayerRef.current = new AudioPlayer();

      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            setIsListening(true);
            audioProcessorRef.current?.start((base64Data) => {
              session.sendRealtimeInput({
                audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
              });
            });
          },
          onmessage: async (message) => {
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData?.data) {
                  audioPlayerRef.current?.playChunk(part.inlineData.data);
                }
              }
            }

            if (message.serverContent?.interrupted) {
              audioPlayerRef.current?.stop();
            }

            if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
              setAiResponse(prev => prev + message.serverContent?.modelTurn?.parts?.[0]?.text);
            }

            // Handle transcriptions
            const transcriptionPart = message.serverContent?.modelTurn?.parts?.find(p => p.text);
            if (transcriptionPart) {
               // We can update UI with text if needed
            }
          },
          onclose: () => {
            stopSession();
          },
          onerror: (error) => {
            console.error("Live API Error:", error);
            stopSession();
          }
        }
      });

      sessionRef.current = session;
    } catch (error) {
      console.error("Failed to connect:", error);
      setIsConnecting(false);
    }
  };

  const stopSession = () => {
    audioProcessorRef.current?.stop();
    audioPlayerRef.current?.stop();
    sessionRef.current?.close();
    setIsConnected(false);
    setIsListening(false);
    setIsConnecting(false);
    setAiResponse("");
  };

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center p-6 font-sans">
      <div className="max-w-2xl w-full space-y-12 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <h1 className="text-5xl font-light tracking-tight text-white/90">
            Carmén Merilaid
          </h1>
          <p className="text-white/50 uppercase tracking-[0.2em] text-xs font-medium">
            Professional Voice Agent
          </p>
        </motion.div>

        <div className="relative flex items-center justify-center py-20">
          <AnimatePresence mode="wait">
            {!isConnected ? (
              <motion.button
                key="start"
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 1.1, opacity: 0 }}
                onClick={startSession}
                disabled={isConnecting}
                className="group relative flex items-center justify-center w-32 h-32 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 transition-all duration-500 disabled:opacity-50"
              >
                {isConnecting ? (
                  <Loader2 className="w-8 h-8 animate-spin text-white/40" />
                ) : (
                  <Play className="w-8 h-8 text-white/80 group-hover:text-white transition-colors" />
                )}
                <div className="absolute inset-0 rounded-full border border-white/5 scale-150 opacity-0 group-hover:opacity-100 group-hover:scale-125 transition-all duration-700" />
              </motion.button>
            ) : (
              <motion.div
                key="active"
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 1.1, opacity: 0 }}
                className="relative flex flex-col items-center space-y-8"
              >
                <div className="relative flex items-center justify-center">
                  <motion.div 
                    animate={{ 
                      scale: [1, 1.2, 1],
                      opacity: [0.1, 0.2, 0.1]
                    }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="absolute w-48 h-48 bg-white rounded-full blur-3xl"
                  />
                  <button
                    onClick={stopSession}
                    className="relative flex items-center justify-center w-32 h-32 rounded-full bg-white text-black hover:bg-white/90 transition-all duration-300 shadow-[0_0_50px_rgba(255,255,255,0.2)]"
                  >
                    <Square className="w-8 h-8 fill-current" />
                  </button>
                </div>
                
                <div className="flex items-center space-x-2 text-white/40 text-sm font-medium tracking-widest uppercase">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
                  </span>
                  <span>Live Connection</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="grid grid-cols-2 gap-8 text-left border-t border-white/5 pt-12">
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-widest text-white/30 font-bold">Languages</p>
            <p className="text-sm text-white/70">English, French, Estonian</p>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-widest text-white/30 font-bold">Voice Profile</p>
            <p className="text-sm text-white/70">Kore (Professional)</p>
          </div>
        </div>

        <motion.div 
          animate={{ opacity: isConnected ? 1 : 0 }}
          className="text-white/40 text-xs italic font-serif max-w-md mx-auto"
        >
          "Speak naturally to learn about Carmén's experience in fashion business and marketing."
        </motion.div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
        body { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}
