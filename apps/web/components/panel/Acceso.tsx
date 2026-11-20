'use client';
/**
 * /panel/acceso/: establecer contraseña desde la invitación o la recuperación de Supabase Auth (signup deshabilitado).
 * supabase-js (detectSessionInUrl) toma el token del hash, crea la sesión y lo borra de la URL; aquí solo se lee
 * el tipo/error del hash ANTES de crear el cliente. Sin enlace válido se ofrece pedir uno nuevo por correo
 * (respuesta neutra: no revela si el correo existe).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { leerEnlaceAuth, mensajeErrorContrasena, MIN_CONTRASENA, problemasContrasena, type TipoEnlace } from '../../lib/panel/acceso';
import { supabase } from '../../lib/panel/api';

type Fase =
  | { tipo: 'cargando' }
  | { tipo: 'nueva'; enlace: TipoEnlace | null; email: string }
  | { tipo: 'lista' }
  | { tipo: 'solicitar'; motivo: 'sin_enlace' | 'vencido' | 'invalido' }
  | { tipo: 'solicitado' };

const TITULOS: Record<Fase['tipo'], string> = {
  cargando: 'Acceso al panel',
  nueva: 'Crea tu contraseña',
  lista: 'Contraseña guardada',
  solicitar: 'Recupera tu acceso',
  solicitado: 'Revisa tu correo',
};

export function Acceso() {
  const [fase, setFase] = useState<Fase>({ tipo: 'cargando' });
  const [errores, setErrores] = useState<string[]>([]);
  const [aviso, setAviso] = useState('');
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    const enlace = leerEnlaceAuth(window.location.hash);
    // El hash puede traer tokens o errores: fuera de la URL antes de cualquier otra cosa (Referer, historial).
    const limpiar = () => window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    if (enlace.error) {
      limpiar();
      setFase({ tipo: 'solicitar', motivo: enlace.error.vencido ? 'vencido' : 'invalido' });
      return;
    }
    let vivo = true;
    supabase()
      .auth.getSession()
      .then(({ data }) => {
        limpiar();
        if (!vivo) return;
        const s = data.session;
        if (s) setFase({ tipo: 'nueva', enlace: enlace.tipo, email: s.user.email ?? '' });
        else setFase({ tipo: 'solicitar', motivo: enlace.tieneToken ? 'invalido' : 'sin_enlace' });
      })
      .catch(() => vivo && setFase({ tipo: 'solicitar', motivo: 'invalido' }));
    return () => {
      vivo = false;
    };
  }, []);

  useEffect(() => {
    if (fase.tipo !== 'cargando') document.getElementById('acceso-titulo')?.focus();
  }, [fase.tipo]);

  async function guardar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const nueva = String(f.get('nueva') ?? '');
    const p = problemasContrasena(nueva, String(f.get('confirmacion') ?? ''));
    setErrores(p);
    setAviso('');
    if (p.length) return;
    setEnviando(true);
    try {
      const { error } = await supabase().auth.updateUser({ password: nueva });
      if (error) return setAviso(mensajeErrorContrasena((error as { code?: string }).code));
      setFase({ tipo: 'lista' });
    } catch {
      setAviso(mensajeErrorContrasena(undefined));
    } finally {
      setEnviando(false);
    }
  }

  async function solicitar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email') ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setErrores(['Escribe un correo válido.']);
    setErrores([]);
    setEnviando(true);
    try {
      await supabase().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/panel/acceso/` });
    } catch {
      /* respuesta neutra */
    } finally {
      setEnviando(false);
      setFase({ tipo: 'solicitado' });
    }
  }

  const descErrores = errores.length ? 'acceso-errores' : undefined;
  return (
    <div className="panel">
      <header className="panel-cabecera">
        <p className="panel-marca">369 Capital Humano · Panel</p>
      </header>
      <main id="contenido" className="panel-main">
        <h1 id="acceso-titulo" tabIndex={-1}>{TITULOS[fase.tipo]}</h1>
        {fase.tipo === 'cargando' && <p className="p-cargando" role="status">Validando tu enlace…</p>}

        {fase.tipo === 'nueva' && (
          <section className="p-tarjeta" aria-labelledby="acceso-titulo" style={{ maxWidth: 460 }}>
            <p>{fase.enlace === 'recovery' ? 'Elige una contraseña nueva' : 'Te invitaron al panel. Elige tu contraseña'}{fase.email ? <> para <strong>{fase.email}</strong></> : null}.</p>
            <form onSubmit={guardar} noValidate>
              <div className="p-campo">
                <label htmlFor="acceso-nueva">Contraseña nueva</label>
                <input id="acceso-nueva" name="nueva" type="password" autoComplete="new-password" required minLength={MIN_CONTRASENA} aria-invalid={errores.length > 0} aria-describedby={['acceso-reglas', descErrores].filter(Boolean).join(' ')} />
                <p id="acceso-reglas" className="p-ayuda">Mínimo {MIN_CONTRASENA} caracteres, con mayúsculas, minúsculas y números.</p>
              </div>
              <div className="p-campo">
                <label htmlFor="acceso-confirmacion">Repite la contraseña</label>
                <input id="acceso-confirmacion" name="confirmacion" type="password" autoComplete="new-password" required aria-invalid={errores.length > 0} aria-describedby={descErrores} />
              </div>
              <button className="p-boton" type="submit" disabled={enviando}>{enviando ? 'Guardando…' : 'Guardar contraseña'}</button>
            </form>
          </section>
        )}

        {fase.tipo === 'lista' && (
          <p className="p-ok" role="status">Tu contraseña quedó guardada y tu sesión está activa. <a href="/panel/">Ir al panel</a></p>
        )}

        {fase.tipo === 'solicitar' && (
          <section className="p-tarjeta" aria-labelledby="acceso-titulo" style={{ maxWidth: 460 }}>
            <p role={fase.motivo === 'sin_enlace' ? undefined : 'alert'}>
              {fase.motivo === 'vencido' ? 'El enlace venció o ya se usó.' : fase.motivo === 'invalido' ? 'El enlace no es válido.' : '¿Olvidaste tu contraseña o no pudiste activar tu invitación?'}{' '}
              Escribe tu correo y te enviaremos un enlace nuevo.
            </p>
            <form onSubmit={solicitar} noValidate>
              <div className="p-campo">
                <label htmlFor="acceso-email">Correo</label>
                <input id="acceso-email" name="email" type="email" autoComplete="username" required aria-invalid={errores.length > 0} aria-describedby={descErrores} />
              </div>
              <button className="p-boton" type="submit" disabled={enviando}>Enviar enlace</button>
            </form>
            <p className="p-ayuda"><a href="/panel/">Volver a iniciar sesión</a></p>
          </section>
        )}

        {fase.tipo === 'solicitado' && (
          <p role="status">Si el correo tiene acceso al panel, te enviamos un enlace para crear tu contraseña. Vence en 15 minutos. <a href="/panel/">Volver a iniciar sesión</a></p>
        )}

        <div id="acceso-errores" aria-live="polite">
          {errores.length > 0 && <ul className="p-error">{errores.map((x) => <li key={x}>{x}</li>)}</ul>}
          {aviso && <p className="p-error" role="alert">{aviso}</p>}
        </div>
      </main>
    </div>
  );
}
