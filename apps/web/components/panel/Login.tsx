'use client';
/** Acceso por invitación (signup deshabilitado) con segundo factor TOTP si el usuario lo tiene (config.toml). */
import { useState, type FormEvent } from 'react';
import { supabase } from '../../lib/panel/api';

type Paso = { tipo: 'credenciales' } | { tipo: 'totp'; factorId: string };

export function Login({ alEntrar }: { alEntrar: () => void | Promise<void> }) {
  const [paso, setPaso] = useState<Paso>({ tipo: 'credenciales' });
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function entrar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    setEnviando(true);
    setError('');
    try {
      await iniciar(d);
    } catch {
      setError('No se pudo iniciar sesión. Intenta de nuevo.');
    } finally {
      setEnviando(false);
    }
  }

  async function iniciar(d: FormData) {
    const sb = supabase();
    const { error: err } = await sb.auth.signInWithPassword({ email: String(d.get('email') ?? '').trim(), password: String(d.get('password') ?? '') });
    if (err) return setError('Correo o contraseña incorrectos.');
    const nivel = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (nivel.data?.nextLevel === 'aal2' && nivel.data.currentLevel !== 'aal2') {
      const factores = await sb.auth.mfa.listFactors();
      const totp = factores.data?.totp?.[0];
      if (totp) return setPaso({ tipo: 'totp', factorId: totp.id });
    }
    await alEntrar();
  }

  async function verificar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (paso.tipo !== 'totp') return;
    const codigo = String(new FormData(e.currentTarget).get('codigo') ?? '').trim();
    setEnviando(true);
    try {
      const { error: err } = await supabase().auth.mfa.challengeAndVerify({ factorId: paso.factorId, code: codigo });
      if (err) return setError('El código no es válido.');
      await alEntrar();
    } catch {
      setError('No se pudo verificar el código. Intenta de nuevo.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="p-tarjeta" aria-labelledby="titulo-login" style={{ maxWidth: 420 }}>
      <h2 id="titulo-login">{paso.tipo === 'credenciales' ? 'Inicia sesión' : 'Verificación en dos pasos'}</h2>
      {paso.tipo === 'credenciales' ? (
        <form onSubmit={entrar} noValidate>
          <div className="p-campo">
            <label htmlFor="login-email">Correo</label>
            <input id="login-email" name="email" type="email" autoComplete="username" required />
          </div>
          <div className="p-campo">
            <label htmlFor="login-password">Contraseña</label>
            <input id="login-password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <button className="p-boton" type="submit" disabled={enviando}>{enviando ? 'Entrando…' : 'Entrar'}</button>
        </form>
      ) : (
        <form onSubmit={verificar} noValidate>
          <div className="p-campo">
            <label htmlFor="login-codigo">Código de tu app de autenticación</label>
            <input id="login-codigo" name="codigo" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required />
          </div>
          <button className="p-boton" type="submit" disabled={enviando}>Verificar</button>
        </form>
      )}
      <p aria-live="polite" className="p-error">{error}</p>
      <p className="p-ayuda">El acceso es solo por invitación. Si no tienes cuenta, pídela a un administrador.</p>
      <p className="p-ayuda"><a href="/panel/acceso/">¿Olvidaste tu contraseña o venció tu invitación?</a></p>
    </section>
  );
}
