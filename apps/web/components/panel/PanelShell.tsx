'use client';
/**
 * Marco del panel (DSH-06): sesión de Supabase Auth, perfil/roles, navegación y login.
 * Sin sesión muestra el formulario de acceso; con sesión entrega `api` y `perfil` por contexto.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { crearApiPanel, supabase, type ApiPanel } from '../../lib/panel/api';
import { esAdmin, type Perfil } from '../../lib/panel/roles';
import { Login } from './Login';

interface CtxPanel { api: ApiPanel; perfil: Perfil }
const Contexto = createContext<CtxPanel | null>(null);

export function usePanel(): CtxPanel {
  const c = useContext(Contexto);
  if (!c) throw new Error('usePanel fuera de PanelShell');
  return c;
}

type Estado = { fase: 'cargando' } | { fase: 'anonimo' } | { fase: 'listo'; ctx: CtxPanel } | { fase: 'error'; mensaje: string };

const ENLACES: Array<{ href: string; texto: string; soloAdmin?: boolean }> = [
  { href: '/panel/', texto: 'Vacantes' },
  { href: '/panel/agenda/', texto: 'Agenda' },
  { href: '/panel/dashboard/', texto: 'Dashboard' },
  { href: '/panel/admin/', texto: 'Alta', soloAdmin: true },
];

export function PanelShell({ titulo, actual, children }: { titulo: string; actual: string; children: ReactNode }) {
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });

  const cargar = useCallback(async () => {
    try {
      const sb = supabase();
      const { data } = await sb.auth.getSession();
      if (!data.session) return setEstado({ fase: 'anonimo' });
      const api = crearApiPanel(sb);
      const perfil = await api.perfil();
      setEstado(perfil ? { fase: 'listo', ctx: { api, perfil } } : { fase: 'anonimo' });
    } catch {
      setEstado({ fase: 'error', mensaje: 'No se pudo cargar tu sesión. Recarga la página.' });
    }
  }, []);

  useEffect(() => {
    void cargar();
    const { data } = supabase().auth.onAuthStateChange((evento) => {
      if (evento === 'SIGNED_OUT') setEstado({ fase: 'anonimo' });
    });
    return () => data.subscription.unsubscribe();
  }, [cargar]);

  const salir = async () => {
    await supabase().auth.signOut();
    setEstado({ fase: 'anonimo' });
  };

  const perfil = estado.fase === 'listo' ? estado.ctx.perfil : null;
  return (
    <div className="panel">
      <a className="panel-saltar" href="#contenido">Saltar al contenido</a>
      <header className="panel-cabecera">
        <p className="panel-marca">369 Capital Humano · Panel</p>
        {perfil && (
          <>
            <nav className="panel-nav" aria-label="Secciones del panel">
              <ul>
                {ENLACES.filter((e) => !e.soloAdmin || esAdmin(perfil)).map((e) => (
                  <li key={e.href}>
                    <a href={e.href} aria-current={e.href === actual ? 'page' : undefined}>{e.texto}</a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="panel-usuario">
              <span>{perfil.email} · {perfil.etiqueta}</span>
              <button type="button" className="p-boton secundario" onClick={salir}>Cerrar sesión</button>
            </div>
          </>
        )}
      </header>
      <main id="contenido" className="panel-main">
        <h1>{estado.fase === 'anonimo' ? 'Acceso al panel' : titulo}</h1>
        {estado.fase === 'cargando' && <p className="p-cargando" role="status">Cargando…</p>}
        {estado.fase === 'error' && <p className="p-error" role="alert">{estado.mensaje}</p>}
        {estado.fase === 'anonimo' && <Login alEntrar={cargar} />}
        {estado.fase === 'listo' && (estado.ctx.perfil.roles.length === 0
          ? <p role="alert">Tu usuario no tiene un rol asignado. Pide acceso a un administrador.</p>
          : <Contexto.Provider value={estado.ctx}>{children}</Contexto.Provider>)}
      </main>
    </div>
  );
}
