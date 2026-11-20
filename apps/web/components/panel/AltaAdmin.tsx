'use client';
/** Alta sin código (NFR-ESC-06): cliente, vacante (con la plantilla por defecto) y asignación de usuarios. Solo admin. */
import { useState, type FormEvent } from 'react';
import { slugDesdeNombre } from '../../../../src/domains/vacantes';
import { mensajePanel, type OperacionPanel } from '../../lib/panel/funciones';
import { esAdmin } from '../../lib/panel/roles';
import { rutaVacante } from '../../lib/panel/rutas';
import { EstadoCarga, useDatos } from './comunes';
import { usePanel } from './PanelShell';

type Aviso = { tipo: 'ok' | 'error'; texto: string } | null;

export function AltaAdmin() {
  const { api, perfil } = usePanel();
  const datos = useDatos(() => api.vacantes(), [api]);
  const [avisos, setAvisos] = useState<Record<string, Aviso>>({});
  const [nombreVacante, setNombreVacante] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTocado, setSlugTocado] = useState(false);

  if (!esAdmin(perfil)) return <p role="alert">Solo un administrador puede dar de alta clientes y vacantes.</p>;

  const enviar = (op: OperacionPanel, armar: (f: FormData) => unknown, exito: (d: Record<string, unknown>) => string) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const r = await api.funciones.panelReglas(op, armar(new FormData(form)));
    if (r.tipo === 'ok') {
      form.reset();
      setAvisos((a) => ({ ...a, [op]: { tipo: 'ok', texto: exito(r.datos) } }));
      datos.recargar();
    } else {
      const detalle = r.problemas.map((p) => `${p.ruta || 'formulario'}: ${p.mensaje}`).join(' · ');
      setAvisos((a) => ({ ...a, [op]: { tipo: 'error', texto: `${mensajePanel(r.codigo)}${detalle ? ` (${detalle})` : ''}` } }));
    }
  };
  const avisoDe = (op: string) => <div aria-live="polite">{avisos[op] && <p className={avisos[op]!.tipo === 'ok' ? 'p-ok' : 'p-error'}>{avisos[op]!.texto}</p>}</div>;

  return (
    <EstadoCarga carga={datos}>
      {({ vacantes, clientes }) => (
        <div className="p-rejilla">
          <form className="p-tarjeta" aria-labelledby="t-cliente" onSubmit={enviar('crear_cliente', (f) => ({ nombre: String(f.get('nombre') ?? '') }), () => 'Cliente creado.')}>
            <h2 id="t-cliente">Nuevo cliente</h2>
            <div className="p-campo"><label htmlFor="n-cliente">Nombre</label><input id="n-cliente" name="nombre" required maxLength={200} /></div>
            <button className="p-boton" type="submit">Crear cliente</button>
            {avisoDe('crear_cliente')}
          </form>

          <form
            className="p-tarjeta"
            aria-labelledby="t-vacante"
            onSubmit={enviar(
              'crear_vacante',
              (f) => ({ cliente_id: String(f.get('cliente_id') ?? ''), nombre: String(f.get('nombre') ?? ''), slug: String(f.get('slug') ?? ''), codigo: String(f.get('codigo') ?? ''), reglas: {} }),
              (d) => {
                setNombreVacante('');
                setSlug('');
                setSlugTocado(false);
                return `Vacante creada con la plantilla por defecto (versión 1). Edita sus reglas en ${rutaVacante(String(d.vacante_id))}`;
              },
            )}
          >
            <h2 id="t-vacante">Nueva vacante</h2>
            <div className="p-campo">
              <label htmlFor="n-v-cliente">Cliente</label>
              <select id="n-v-cliente" name="cliente_id" required defaultValue="">
                <option value="" disabled>Elige un cliente</option>
                {clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
            <div className="p-campo">
              <label htmlFor="n-v-nombre">Nombre</label>
              <input id="n-v-nombre" name="nombre" required maxLength={200} value={nombreVacante} onChange={(e) => { setNombreVacante(e.target.value); if (!slugTocado) setSlug(slugDesdeNombre(e.target.value)); }} />
            </div>
            <div className="p-campo">
              <label htmlFor="n-v-slug">Slug (URL)</label>
              <input id="n-v-slug" name="slug" required maxLength={80} value={slug} aria-describedby="n-v-slug-ayuda" onChange={(e) => { setSlug(e.target.value); setSlugTocado(true); }} />
              <p id="n-v-slug-ayuda" className="p-ayuda">La landing vivirá en /vacantes/{slug || 'slug'}/ (su contenido se publica con un JSON y un build).</p>
            </div>
            <div className="p-campo"><label htmlFor="n-v-codigo">Código</label><input id="n-v-codigo" name="codigo" required maxLength={40} /></div>
            <button className="p-boton" type="submit">Crear vacante</button>
            {avisoDe('crear_vacante')}
          </form>

          <form
            className="p-tarjeta"
            aria-labelledby="t-asignar"
            onSubmit={enviar('asignar_usuario', (f) => ({ email: String(f.get('email') ?? ''), rol: String(f.get('rol') ?? ''), vacante_id: String(f.get('vacante_id') ?? '') }), () => 'Usuario asignado.')}
          >
            <h2 id="t-asignar">Asignar usuario a una vacante</h2>
            <div className="p-campo"><label htmlFor="n-a-email">Correo del usuario</label><input id="n-a-email" name="email" type="email" required aria-describedby="n-a-ayuda" /><p id="n-a-ayuda" className="p-ayuda">El usuario debe existir (invitación desde Supabase Auth).</p></div>
            <div className="p-campo">
              <label htmlFor="n-a-rol">Rol</label>
              <select id="n-a-rol" name="rol" defaultValue="reclutador"><option value="reclutador">Reclutador</option><option value="cliente">Cliente (solo lectura)</option></select>
            </div>
            <div className="p-campo">
              <label htmlFor="n-a-vacante">Vacante</label>
              <select id="n-a-vacante" name="vacante_id" required defaultValue="">
                <option value="" disabled>Elige una vacante</option>
                {vacantes.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
              </select>
            </div>
            <button className="p-boton" type="submit">Asignar</button>
            {avisoDe('asignar_usuario')}
          </form>
        </div>
      )}
    </EstadoCarga>
  );
}
