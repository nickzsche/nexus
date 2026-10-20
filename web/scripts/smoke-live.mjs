// Gerçek API duman testi (Node 22: global WebSocket + fetch). Anahtar yalnızca ortamdan okunur, asla yazdırılmaz.
//   set -a; . "$HOME/Library/Application Support/Jarvis/.env"; set +a; node scripts/smoke-live.mjs
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY ortamda yok.'); process.exit(2); }
const MODEL = 'gemini-2.5-flash-native-audio-latest';       // kullanıcının seçtiği model; başkası denenmez
const URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(KEY)}`;
const SYS = 'Sen NOVA\'sın: enerjik, sıcak bir sesli asistan. Kısa, doğal Türkçe konuş; çoğu cevap bir iki cümle. Kullanıcıya "reis" de.';
const PROMPTS = ['Merhaba, nasılsın bugün?', 'Bir kelimeyle selam ver.', 'Sence en güzel mevsim hangisi?', 'Kısaca bir şaka yap.', 'Bugün ne yapsam?', 'Bana moral ver.', 'En sevdiğin renk ne?', 'Bana tek cümlelik bir tavsiye ver.'];
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const ms = (t0) => Math.round(performance.now() - t0);

function live() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const st = { ws, waiters: [], audioBytes: 0, firstAudio: null, t0: 0, out: '', turn: null };
    ws.onopen = () => ws.send(JSON.stringify({ setup: {
      model: `models/${MODEL}`,
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } } },
      systemInstruction: { parts: [{ text: SYS }] }, inputAudioTranscription: {}, outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} }, sessionResumption: {},
      realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', silenceDurationMs: 500 } },
    } }));
    ws.onerror = () => reject(new Error('WebSocket hatası'));
    ws.onclose = (e) => { if (!st.ready) reject(new Error(`kapandı ${e.code} ${e.reason}`)); };
    ws.onmessage = async (ev) => {
      const txt = typeof ev.data === 'string' ? ev.data : Buffer.from(await ev.data.arrayBuffer()).toString();
      const m = JSON.parse(txt);
      if (m.setupComplete !== undefined) { st.ready = true; resolve(st); return; }
      const sc = m.serverContent;
      if (!sc) return;
      for (const p of sc.modelTurn?.parts ?? []) {
        const d = p.inlineData?.data;
        if (d) { st.audioBytes += Math.floor(d.length * 3 / 4); if (st.firstAudio === null) st.firstAudio = ms(st.t0); }
      }
      if (sc.outputTranscription?.text) st.out += sc.outputTranscription.text;
      if (sc.turnComplete && st.turn) { const f = st.turn; st.turn = null; f(); }
    };
  });
}

async function turn(st, method, text, timeout = 30000) {
  st.firstAudio = null; st.audioBytes = 0; st.out = '';
  const done = new Promise((r) => { st.turn = r; });
  st.t0 = performance.now();
  st.ws.send(JSON.stringify(method === 'clientContent'
    ? { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }
    : { realtimeInput: { text } }));
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error(`tur zaman aşımı (${timeout / 1000} sn)`)), timeout))]);
  return { first: st.firstAudio, bytes: st.audioBytes, text: st.out.trim() };
}

async function liveSmoke() {
  console.log(`== Live (${MODEL}) ==`);
  const t0 = performance.now();
  let st = await live();
  console.log(`oturum açma: ${ms(t0)} ms`);
  const res = { clientContent: [], 'realtimeInput.text': [] };
  const hung = { clientContent: 0, 'realtimeInput.text': 0 };
  const methods = ['clientContent', 'realtimeInput.text'];
  for (let i = 0; i < PROMPTS.length; i++) {
    const method = methods[i % 2];
    try {
      const r = await turn(st, method, PROMPTS[i], 20000);
      if (!r.bytes || !r.text) throw new Error(`ses ya da transkript yok (${r.bytes} bayt)`);
      res[method].push(r.first);
      console.log(`  ${method.padEnd(20)} ilk ses ${String(r.first).padStart(5)} ms | ${(r.bytes / 48000).toFixed(1)} sn ses | "${r.text.slice(0, 60)}"`);
    } catch (e) {
      hung[method]++;
      console.log(`  ${method.padEnd(20)} TAMAMLANMADI: ${e.message}`);
      try { st.ws.close(1000); } catch {}
      st = await live();                                   // takılan oturumu bırak, yenisini aç
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }
  st.ws.close(1000);
  for (const [k, v] of Object.entries(res)) console.log(`  ${k.padEnd(20)} ilk ses: [${v.join(', ')}] ms  medyan ${median(v)} ms  takılan tur: ${hung[k]}`);
  const a = median(res.clientContent), b = median(res['realtimeInput.text']);
  if (a != null && b != null) console.log(`  → ${a <= b ? 'clientContent' : 'realtimeInput.text'} daha hızlı (medyan farkı ${Math.abs(a - b)} ms)`);
}

async function post(path, body, timeout = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body), signal: ctl.signal });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, json: j };
  } finally { clearTimeout(t); }
}

async function auxSmoke() {
  console.log('== Aux (REST) ==');
  for (const model of ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']) {
    const t0 = performance.now();
    const r = await post('/interactions', { model, input: [{ type: 'user_input', content: [{ type: 'text', text: 'Operatör, kanal açık.', annotations: [{ type: 'speech_metadata', style: 'terse, radio report' }] }] }], response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: 'Alnilam' }] } });
    const audio = (r.json?.steps ?? []).flatMap((s) => s.content ?? []).find((c) => c.type === 'audio');
    console.log(`  TTS interactions ${model.padEnd(27)} HTTP ${r.status} ${ms(t0)} ms ${audio ? `OK ${audio.mime_type} ${(audio.data.length * 3 / 4 / 1024).toFixed(0)} KB` : (r.json?.error?.message ?? '').slice(0, 80)}`);
    const g = await post(`/models/${model}:generateContent`, { contents: [{ parts: [{ text: 'merhaba' }] }], generationConfig: { responseModalities: ['AUDIO'] } });
    console.log(`  TTS generateContent ${model.padEnd(24)} HTTP ${g.status}`);
  }
  for (const model of ['gemini-flash-latest', 'gemini-3-flash-preview']) {
    const t0 = performance.now();
    try {
      const r = await post(`/models/${model}:generateContent`, { systemInstruction: { parts: [{ text: 'Sen SENTINEL\'sin: telsiz diliyle kısa konuşan güvenlik bekçisi.' }] }, contents: [{ role: 'user', parts: [{ text: 'FORGE "deploy ettim" dedi. Ona araya giren tek kısa cümle yaz (en fazla 18 kelime).' }] }], generationConfig: { temperature: 1.0 } }, 10000);
      const t = r.json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
      console.log(`  metin ${model.padEnd(24)} HTTP ${r.status} ${ms(t0)} ms ${t ? `"${t.trim().slice(0, 80)}"` : (r.json?.error?.message ?? '').slice(0, 60)}`);
    } catch (e) { console.log(`  metin ${model.padEnd(24)} ${e.name} ${ms(t0)} ms`); }
  }
}

try { await liveSmoke(); } catch (e) { console.error('Live HATA:', e.message); process.exitCode = 1; }
try { await auxSmoke(); } catch (e) { console.error('Aux HATA:', e.message); process.exitCode = 1; }
