import { useCallback, useEffect, useState } from 'react';
import { CHIPS } from './data/chips';
import { useNexus } from './state/store';
import { Boot } from './ui/Boot';
import { Chat } from './ui/Chat';
import { Chaos, SwitchOverlay, Toasts } from './ui/Effects';
import { applyTheme, useShortcuts } from './ui/hooks';
import { ArenaDock, Modals } from './ui/Modals';
import { ArenaButton, Events, Ledger, LinkStatus, Matrix, Telemetry, Timers } from './ui/Panels';
import { Stage } from './ui/Stage';
import { TopBar } from './ui/TopBar';

export default function App() {
  const active = useNexus((s) => s.active);
  const hasKey = useNexus((s) => s.hasKey);
  const onboarded = useNexus((s) => s.settings.onboarded);
  const modal = useNexus((s) => s.modal);
  const arenaPhase = useNexus((s) => s.arena.phase);
  const open = useNexus((s) => s.openModal);
  const [boot, setBoot] = useState(() => !new URLSearchParams(location.search).has('noboot'));
  const done = useCallback(() => setBoot(false), []);

  useShortcuts();
  useEffect(() => { applyTheme(CHIPS[active].colors); }, [active]);
  useEffect(() => { if (!boot && !hasKey && !onboarded && modal === null) open('onboarding'); }, [boot, hasKey, onboarded, modal, open]);
  useEffect(() => { if (arenaPhase !== 'idle' && modal === 'arena') open(null); }, [arenaPhase, modal, open]);   // düello başlayınca kurulum modalı kapanır

  return (
    <div id="app">
      <TopBar />
      <aside className="col left" aria-label="Telemetri"><Telemetry /><Timers /><Ledger /></aside>
      <main className="center"><Stage /><Chat /><ArenaDock /></main>
      <aside className="col right" aria-label="İlişkiler"><LinkStatus /><ArenaButton /><Matrix /><Events /></aside>
      <Modals />
      <SwitchOverlay />
      <Chaos />
      <Toasts />
      {boot && <Boot onDone={done} />}
    </div>
  );
}
