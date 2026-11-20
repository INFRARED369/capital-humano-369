'use client';
import { useRef, useState } from 'react';
import { HITOS_VACIOS, hitosVideo } from '../../../lib/captacion/video';
import { track } from '../../../lib/tracking';
import { IMG } from '../../../lib/captacion/recursos';

const tiempo = (s: number) => (!Number.isFinite(s) || s < 0 ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

export interface ContenidoVideo { src: string; poster?: string; etiqueta: string; presentador: { titulo: string; subtitulo: string }; leyenda: string; sticker: string }

/**
 * Reproductor del video de la vacante con eventos VideoPlay / VideoProgress50 / VideoComplete (una vez cada uno).
 * `preload="none"` + póster ligero (12 KB): el MP4 de 9.6 MB no se toca hasta que la persona da play (NFR-RND-01).
 */
export function VideoVacante({ v }: { v: ContenidoVideo }) {
  const ref = useRef<HTMLVideoElement>(null);
  const hitos = useRef(HITOS_VACIOS);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [terminado, setTerminado] = useState(false);
  const [silencio, setSilencio] = useState(false);
  const [t, setT] = useState({ actual: 0, duracion: 0 });

  const evaluar = (el: HTMLVideoElement, fin = false) => {
    const r = hitosVideo(hitos.current, { reproduciendo: !el.paused, actual: el.currentTime, duracion: el.duration || 0, terminado: fin });
    hitos.current = r.estado;
    for (const e of r.eventos) track(e, { video: v.src.split('/').pop() });
  };
  const alternar = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused || el.ended) void el.play().catch(() => {});
    else el.pause();
  };
  const pct = t.duracion > 0 ? (t.actual / t.duracion) * 100 : 0;

  return (
    <div className="video-card-wrapper">
      <div className="hero-sticker-badge" aria-hidden="true"><img src={IMG.marca.src} width={IMG.marca.width} height={IMG.marca.height} alt="" /><small>{v.sticker}</small></div>
      <div className="video-card">
        <div className="video-badge-top"><span className="live-indicator"><span className="pulse-dot"></span> {v.etiqueta}</span></div>
        <div className={`video-stage${reproduciendo ? ' is-playing' : ''}`} onClick={alternar}>
          <video ref={ref} className="recruitment-video-el" preload="none" playsInline poster={v.poster} aria-label={v.etiqueta}
            onPlay={(e) => { setReproduciendo(true); setTerminado(false); evaluar(e.currentTarget); }}
            onPause={() => setReproduciendo(false)}
            onLoadedMetadata={(e) => setT({ actual: 0, duracion: e.currentTarget.duration })}
            onTimeUpdate={(e) => { setT({ actual: e.currentTarget.currentTime, duracion: e.currentTarget.duration || 0 }); evaluar(e.currentTarget); }}
            onEnded={(e) => { setReproduciendo(false); setTerminado(true); evaluar(e.currentTarget, true); }}>
            <source src={v.src} type="video/mp4" />
            Tu navegador no soporta reproducción de video HTML5.
          </video>
          <div className="video-overlay-ui">
            <div className="video-avatar-presenter">
              <div className="avatar-circle"><img src={IMG.marca.src} width={IMG.marca.width} height={IMG.marca.height} alt="" /></div>
              <div className="presenter-info"><strong>{v.presentador.titulo}</strong><span>{v.presentador.subtitulo}</span></div>
            </div>
            <div className="video-center-play">
              <button type="button" className="play-btn-circle" aria-label={reproduciendo ? 'Pausar video' : 'Reproducir invitación'} onClick={(e) => { e.stopPropagation(); alternar(); }}>
                {reproduciendo ? '⏸' : terminado ? '↻' : '▶'}
              </button>
              <div className="video-hint">{reproduciendo ? 'Haz clic para pausar' : 'Haz clic para reproducir el video informativo'}</div>
            </div>
            <div className="video-caption-box">{v.leyenda}</div>
          </div>
        </div>
        <div className="video-controls-bar">
          <button type="button" className="video-ctrl-btn" aria-label={reproduciendo ? 'Pausar' : 'Reproducir'} onClick={alternar}>{reproduciendo ? '⏸' : '▶'}</button>
          <span>{tiempo(t.actual)} / {tiempo(t.duracion)}</span>
          <div className="video-progress-track" role="slider" tabIndex={0} aria-label="Progreso del video" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
            onClick={(e) => { const el = ref.current; if (!el?.duration) return; const r = e.currentTarget.getBoundingClientRect(); el.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * el.duration; }}
            onKeyDown={(e) => { const el = ref.current; if (!el?.duration) return; if (e.key === 'ArrowRight') el.currentTime = Math.min(el.duration, el.currentTime + 5); if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 5); }}>
            <div className="video-progress-fill" style={{ width: `${pct}%` }}></div>
          </div>
          <button type="button" className="video-ctrl-btn" aria-label={silencio ? 'Activar audio' : 'Silenciar'} onClick={() => { const el = ref.current; if (el) { el.muted = !el.muted; setSilencio(el.muted); } }}>{silencio ? '🔇' : '🔊'}</button>
          <button type="button" className="video-ctrl-btn" aria-label="Pantalla completa" onClick={() => void ref.current?.requestFullscreen?.().catch(() => {})}>⛶</button>
        </div>
      </div>
    </div>
  );
}
