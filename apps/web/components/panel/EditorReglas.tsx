'use client';
/**
 * Editor de reglas por vacante (DSH-04): agenda, plantillas, ventana de contacto y calendario de Zoho,
 * con validación en vivo (el mismo Zod que el servidor), cambios pendientes (diff), vista previa de slots
 * (generarSlots en el navegador), versión y auditoría (S4). Guardar → edge function panel-reglas.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { PLANTILLAS_DEFECTO, TIPOS_MENSAJE, type TipoMensaje } from '../../../../src/domains/comunicacion';
import { PLANTILLA_VACANTE_DEFECTO, ReglasVacanteSchema, advertenciasReglas, diffReglas, normalizarReglas, type ReglasVacante } from '../../../../src/domains/vacantes';
import { systemClock } from '../../../../src/shared/clock';
import type { EntradaHistorial, Vacante } from '../../lib/panel/api';
import { asignar, bloqueoDesdeFormulario, problemasPorCampo, textoAFechas, textoAVentanas, ventanasATexto, vistaPrevia } from '../../lib/panel/editor';
import { mensajePanel } from '../../lib/panel/funciones';
import { puedeEditarCalendario, puedeEditarReglas } from '../../lib/panel/roles';
import { esUuid, leerParam } from '../../lib/panel/rutas';
import { EstadoCarga, useDatos, useUbicacion } from './comunes';
import { usePanel } from './PanelShell';

const ZONAS = ['America/Mexico_City', 'America/Monterrey', 'America/Merida', 'America/Cancun', 'America/Chihuahua', 'America/Mazatlan', 'America/Hermosillo', 'America/Tijuana'];
const DIAS_ISO: Array<[number, string]> = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [7, 'Dom']];
const DIAS_JS: Array<[number, string]> = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [0, 'Dom']];
const NOMBRE_TIPO: Record<TipoMensaje, string> = {
  otp: 'Código de verificación', confirmacion: 'Confirmación', recordatorio_24h: 'Recordatorio largo', recordatorio_2h: 'Recordatorio corto',
  cancelacion: 'Cancelación', reprogramacion: 'Reprogramación', agradecimiento: 'Agradecimiento',
};
const corto = (v: unknown) => {
  const s = v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
};
const leer = (o: unknown, ruta: string): unknown => ruta.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);

export function EditorReglas() {
  const { api } = usePanel();
  const loc = useUbicacion();
  // Vive aquí (no en el formulario): al guardar se recarga la versión y el formulario se vuelve a montar.
  const [guardado, setGuardado] = useState<string | null>(null);
  const id = loc ? leerParam(loc.search, 'id') : null;
  const carga = useDatos(async () => {
    if (!esUuid(id)) return null;
    const [{ vacantes }, vigente, historial] = await Promise.all([api.vacantes(), api.reglasVigentes(id), api.historial(id)]);
    return { vacante: vacantes.find((v) => v.id === id) ?? null, vigente, historial };
  }, [api, id]);

  if (!loc) return <p className="p-cargando" role="status">Cargando…</p>;
  if (!esUuid(id)) return <p className="p-error" role="alert">Falta el identificador de la vacante. Vuelve a la <a href="/panel/">lista de vacantes</a>.</p>;
  return (
    <>
    <div aria-live="polite">{guardado && <p className="p-ok">{guardado}</p>}</div>
    <EstadoCarga carga={carga}>
      {(d) =>
        !d?.vacante ? (
          <p role="alert">La vacante no existe o no tienes acceso.</p>
        ) : (
          <Formulario key={d.vigente?.version ?? 0} vacante={d.vacante} version={d.vigente?.version ?? 0} guardadas={d.vigente?.reglas ?? null} historial={d.historial} alGuardar={(texto) => { setGuardado(texto); carga.recargar(); }} alEditar={() => setGuardado(null)} />
        )
      }
    </EstadoCarga>
    </>
  );
}

function Formulario({ vacante, version, guardadas, historial, alGuardar, alEditar }: { vacante: Vacante; version: number; guardadas: unknown; historial: EntradaHistorial[]; alGuardar: (texto: string) => void; alEditar: () => void }) {
  const { api, perfil } = usePanel();
  const editable = puedeEditarReglas(perfil, vacante.id);
  const inicial = useMemo(() => {
    const r = guardadas === null ? null : ReglasVacanteSchema.safeParse(guardadas);
    return { reglas: r?.success ? r.data : PLANTILLA_VACANTE_DEFECTO, invalidas: r !== null && r.success === false };
  }, [guardadas]);
  const [borrador, setBorrador] = useState<ReglasVacante>(inicial.reglas);
  const [textos, setTextos] = useState({ ventanas: ventanasATexto(inicial.reglas.agenda.ventanas_inicio), festivos: inicial.reglas.agenda.festivos.join(', ') });
  const [erroresTexto, setErroresTexto] = useState<Record<string, string>>({});
  const [bloqueo, setBloqueo] = useState({ fecha: '', desde: '', hasta: '', motivo: '' });
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [problemasServidor, setProblemasServidor] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState(false);

  const validacion = useMemo(() => normalizarReglas(borrador), [borrador]);
  const errores = { ...(validacion.ok === true ? {} : problemasPorCampo(validacion.error)), ...problemasServidor, ...erroresTexto };
  const valido = validacion.ok && Object.keys(erroresTexto).length === 0;
  const cambios = useMemo(() => (validacion.ok === true ? diffReglas(inicial.reglas, validacion.value) : []), [validacion, inicial.reglas]);
  const previa = useMemo(() => (validacion.ok === true ? vistaPrevia(validacion.value, systemClock, 7) : []), [validacion]);
  const advertencias = validacion.ok === true ? advertenciasReglas(validacion.value) : [];

  const cambiar = (ruta: string, valor: unknown) => {
    setBorrador((b) => asignar(b, ruta, valor));
    setProblemasServidor({});
    setAviso(null);
    alEditar();
  };
  const numero = (ruta: string) => (e: { target: { value: string } }) => cambiar(ruta, e.target.value === '' ? undefined : Number(e.target.value));
  const conjunto = (ruta: string, n: number, marcado: boolean) => {
    const actual = (leer(borrador, ruta) as number[] | undefined) ?? [];
    cambiar(ruta, marcado ? [...new Set([...actual, n])].sort((a, b) => a - b) : actual.filter((x) => x !== n));
  };
  const props = (ruta: string, idCampo: string) => ({
    id: idCampo,
    'aria-invalid': errores[ruta] ? (true as const) : undefined,
    'aria-describedby': errores[ruta] ? `${idCampo}-error` : undefined,
  });
  const errorDe = (ruta: string, idCampo: string) => (errores[ruta] ? <p id={`${idCampo}-error`} className="p-error">{errores[ruta]}</p> : null);

  // Funciones de render (no componentes): así React no remonta el input en cada tecla.
  function numeroCampo(ruta: string, etiqueta: string, ayuda?: string, paso = 1) {
    const idc = `c-${ruta.replace(/\./g, '-')}`;
    const v = leer(borrador, ruta);
    return (
      <div className="p-campo">
        <label htmlFor={idc}>{etiqueta}</label>
        <input {...props(ruta, idc)} type="number" step={paso} value={typeof v === 'number' ? v : ''} onChange={numero(ruta)} />
        {ayuda && <p className="p-ayuda">{ayuda}</p>}
        {errorDe(ruta, idc)}
      </div>
    );
  }

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (validacion.ok === false || !valido) return setAviso({ tipo: 'error', texto: 'Corrige los campos marcados antes de guardar.' });
    setGuardando(true);
    const r = await api.funciones.panelReglas<{ version: number; sin_cambios: boolean }>('guardar_reglas', { vacante_id: vacante.id, reglas: validacion.value, version_base: version });
    setGuardando(false);
    if (r.tipo === 'ok') {
      if (r.datos.sin_cambios) return setAviso({ tipo: 'ok', texto: 'No había cambios que guardar.' });
      return alGuardar(`Guardado como versión ${r.datos.version}. La landing usa estas reglas de inmediato.`);
    }
    setProblemasServidor(problemasPorCampo(r.problemas));
    setAviso({ tipo: 'error', texto: mensajePanel(r.codigo) });
  }

  const zona = borrador.agenda.zona_horaria;
  return (
    <>
      <p>
        <strong>{vacante.nombre}</strong> · {version === 0 ? 'usa la plantilla por defecto (sin versión guardada)' : `versión vigente ${version}`}
        {!editable && ' · solo lectura'}
      </p>
      {inicial.invalidas && <p className="p-aviso" role="alert">Las reglas guardadas no son válidas con el esquema actual; se muestra la plantilla por defecto.</p>}
      <div className="p-columnas">
        <form onSubmit={guardar} noValidate aria-label="Reglas de la vacante">
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
            <fieldset className="p-grupo">
              <legend>Agenda</legend>
              <div className="p-campo">
                <label htmlFor="c-zona">Zona horaria</label>
                <select id="c-zona" value={zona} onChange={(e) => cambiar('agenda.zona_horaria', e.target.value)}>
                  {[...new Set([zona, ...ZONAS])].map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
              </div>
              <fieldset className="p-grupo">
                <legend>Días hábiles</legend>
                <div className="p-checks">
                  {DIAS_ISO.map(([n, t]) => (
                    <label key={n}><input type="checkbox" checked={borrador.agenda.dias_habiles.includes(n)} onChange={(e) => conjunto('agenda.dias_habiles', n, e.target.checked)} />{t}</label>
                  ))}
                </div>
                {errorDe("agenda.dias_habiles", "c-dias")}
              </fieldset>
              <div className="p-campo">
                <label htmlFor="c-ventanas">Horarios de inicio (rangos)</label>
                <input
                  id="c-ventanas"
                  aria-invalid={errores.ventanas || errores['agenda.ventanas_inicio'] ? true : undefined}
                  aria-describedby="c-ventanas-ayuda"
                  value={textos.ventanas}
                  onChange={(e) => {
                    const t = e.target.value;
                    setTextos((x) => ({ ...x, ventanas: t }));
                    const r = textoAVentanas(t);
                    setErroresTexto(({ ventanas: _v, ...resto }) => (r.ok === true ? resto : { ...resto, ventanas: r.error }));
                    if (r.ok) cambiar('agenda.ventanas_inicio', r.value);
                  }}
                />
                <p id="c-ventanas-ayuda" className="p-ayuda">Ej.: 09:30-13:00, 15:00-17:00 (inicio y fin incluidos).</p>
                {(errores.ventanas || errores['agenda.ventanas_inicio']) && <p className="p-error">{errores.ventanas ?? errores['agenda.ventanas_inicio']}</p>}
              </div>
              <div className="p-rejilla">
                {numeroCampo("agenda.intervalo_min", 'Intervalo (min)')}
                {numeroCampo("agenda.capacidad_por_slot", 'Personas por horario')}
                {numeroCampo("agenda.cupo_diario", 'Cupo diario')}
                {numeroCampo("agenda.duracion_cita_min", 'Duración de la cita (min)')}
                {numeroCampo("agenda.antelacion_min_horas", 'Antelación mínima (h)', undefined, 0.5)}
                {numeroCampo("agenda.horizonte_dias", 'Días a ofrecer', 'Contando hoy.')}
                {numeroCampo("agenda.ttl_retencion_min", 'Retención para el OTP (min)')}
              </div>
              <div className="p-checks">
                <label><input type="checkbox" checked={borrador.agenda.permitir_empalmes} onChange={(e) => cambiar('agenda.permitir_empalmes', e.target.checked)} />Permitir citas empalmadas entre candidatos</label>
              </div>
              <div className="p-campo">
                <label htmlFor="c-festivos">Días festivos</label>
                <textarea
                  id="c-festivos"
                  rows={2}
                  aria-invalid={errores.festivos || errores['agenda.festivos'] ? true : undefined}
                  value={textos.festivos}
                  onChange={(e) => {
                    const t = e.target.value;
                    setTextos((x) => ({ ...x, festivos: t }));
                    const r = textoAFechas(t);
                    setErroresTexto(({ festivos: _f, ...resto }) => (r.ok === true ? resto : { ...resto, festivos: r.error }));
                    if (r.ok) cambiar('agenda.festivos', r.value);
                  }}
                />
                <p className="p-ayuda">AAAA-MM-DD separados por coma.</p>
                {(errores.festivos || errores['agenda.festivos']) && <p className="p-error">{errores.festivos ?? errores['agenda.festivos']}</p>}
              </div>
              <fieldset className="p-grupo">
                <legend>Bloqueos manuales</legend>
                {borrador.agenda.bloqueos.length === 0 ? <p className="p-ayuda">Sin bloqueos.</p> : (
                  <ul className="p-lista">
                    {borrador.agenda.bloqueos.map((b, i) => (
                      <li key={`${b.desde}-${i}`}>
                        {new Date(b.desde).toLocaleString('es-MX', { timeZone: zona, dateStyle: 'medium', timeStyle: 'short' })} – {new Date(b.hasta).toLocaleTimeString('es-MX', { timeZone: zona, timeStyle: 'short' })}
                        {b.motivo ? ` · ${b.motivo}` : ''}{' '}
                        <button type="button" className="p-boton secundario" onClick={() => cambiar('agenda.bloqueos', borrador.agenda.bloqueos.filter((_, j) => j !== i))}>Quitar<span className="panel-saltar"> bloqueo {i + 1}</span></button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="p-rejilla">
                  <div className="p-campo"><label htmlFor="b-fecha">Fecha</label><input id="b-fecha" type="date" value={bloqueo.fecha} onChange={(e) => setBloqueo({ ...bloqueo, fecha: e.target.value })} /></div>
                  <div className="p-campo"><label htmlFor="b-desde">Desde</label><input id="b-desde" type="time" value={bloqueo.desde} onChange={(e) => setBloqueo({ ...bloqueo, desde: e.target.value })} /></div>
                  <div className="p-campo"><label htmlFor="b-hasta">Hasta</label><input id="b-hasta" type="time" value={bloqueo.hasta} onChange={(e) => setBloqueo({ ...bloqueo, hasta: e.target.value })} /></div>
                  <div className="p-campo"><label htmlFor="b-motivo">Motivo (opcional)</label><input id="b-motivo" maxLength={120} value={bloqueo.motivo} onChange={(e) => setBloqueo({ ...bloqueo, motivo: e.target.value })} /></div>
                </div>
                <button
                  type="button"
                  className="p-boton secundario"
                  onClick={() => {
                    const r = bloqueoDesdeFormulario(bloqueo, zona);
                    setErroresTexto(({ bloqueo: _b, ...resto }) => (r.ok === true ? resto : { ...resto, bloqueo: r.error }));
                    if (r.ok) {
                      cambiar('agenda.bloqueos', [...borrador.agenda.bloqueos, r.value]);
                      setBloqueo({ fecha: '', desde: '', hasta: '', motivo: '' });
                    }
                  }}
                >
                  Agregar bloqueo
                </button>
                {errores.bloqueo && <p className="p-error" role="alert">{errores.bloqueo}</p>}
              </fieldset>
            </fieldset>

            <fieldset className="p-grupo">
              <legend>Mensajes</legend>
              <div className="p-campo">
                <label htmlFor="c-canal">Canal preferido</label>
                <select id="c-canal" value={borrador.mensajes.canal_preferido} onChange={(e) => cambiar('mensajes.canal_preferido', e.target.value)}>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Correo</option>
                  <option value="sms">SMS</option>
                </select>
              </div>
              <div className="p-rejilla">
                {(['h24', 'h2'] as const).map((k) => (
                  <fieldset key={k} className="p-grupo">
                    <legend>{k === 'h24' ? 'Recordatorio largo' : 'Recordatorio corto'}</legend>
                    <div className="p-checks"><label><input type="checkbox" checked={borrador.mensajes.recordatorios[k].activo} onChange={(e) => cambiar(`mensajes.recordatorios.${k}.activo`, e.target.checked)} />Activo</label></div>
                    {numeroCampo(`mensajes.recordatorios.${k}.horas_antes`, 'Horas antes de la cita')}
                  </fieldset>
                ))}
              </div>
              <fieldset className="p-grupo">
                <legend>Ventana de contacto</legend>
                <div className="p-rejilla">
                  <div className="p-campo"><label htmlFor="c-vc-ini">Desde</label><input id="c-vc-ini" type="time" value={borrador.mensajes.ventana_contacto.inicio} onChange={(e) => cambiar('mensajes.ventana_contacto.inicio', e.target.value)} /></div>
                  <div className="p-campo"><label htmlFor="c-vc-fin">Hasta</label><input {...props('mensajes.ventana_contacto.fin', 'c-vc-fin')} type="time" value={borrador.mensajes.ventana_contacto.fin} onChange={(e) => cambiar('mensajes.ventana_contacto.fin', e.target.value)} />{errorDe("mensajes.ventana_contacto.fin", "c-vc-fin")}</div>
                  <div className="p-campo">
                    <label htmlFor="c-vc-zona">Zona</label>
                    <select id="c-vc-zona" value={borrador.mensajes.ventana_contacto.zona_horaria} onChange={(e) => cambiar('mensajes.ventana_contacto.zona_horaria', e.target.value)}>
                      {[...new Set([borrador.mensajes.ventana_contacto.zona_horaria, ...ZONAS])].map((z) => <option key={z} value={z}>{z}</option>)}
                    </select>
                  </div>
                </div>
                <div className="p-checks" role="group" aria-label="Días de contacto">
                  {DIAS_JS.map(([n, t]) => (
                    <label key={n}><input type="checkbox" checked={borrador.mensajes.ventana_contacto.dias.includes(n)} onChange={(e) => conjunto('mensajes.ventana_contacto.dias', n, e.target.checked)} />{t}</label>
                  ))}
                </div>
                <p className="p-ayuda">Fuera de la ventana los mensajes se posponen (el código de verificación nunca).</p>
              </fieldset>
              <h3>Plantillas</h3>
              <p className="p-ayuda">Vacío = plantilla general. Variables: {'{{nombre}} {{folio}} {{fecha}} {{hora}} {{link_cancelar}} {{link_reprogramar}}'}. El mensaje del código de verificación no se edita aquí.</p>
              {TIPOS_MENSAJE.filter((t) => t !== 'otp').map((t) => {
                const ruta = `mensajes.plantillas.${t}.texto`;
                const idc = `c-pl-${t}`;
                return (
                  <div className="p-campo" key={t}>
                    <label htmlFor={idc}>{NOMBRE_TIPO[t]}</label>
                    <textarea
                      {...props(ruta, idc)}
                      rows={3}
                      maxLength={1000}
                      placeholder={PLANTILLAS_DEFECTO[t].texto}
                      value={borrador.mensajes.plantillas[t]?.texto ?? ''}
                      onChange={(e) => cambiar(`mensajes.plantillas.${t}`, e.target.value.trim() === '' ? undefined : { ...borrador.mensajes.plantillas[t], texto: e.target.value })}
                    />
                    {errorDe(ruta, idc)}
                  </div>
                );
              })}
            </fieldset>

            <fieldset className="p-grupo">
              <legend>Zoho Calendar</legend>
              <div className="p-campo">
                <label htmlFor="c-zoho">UID del calendario de la vacante</label>
                <input
                  {...props('zoho_calendar_uid', 'c-zoho')}
                  value={borrador.zoho_calendar_uid ?? ''}
                  disabled={!puedeEditarCalendario(perfil)}
                  onChange={(e) => cambiar('zoho_calendar_uid', e.target.value.trim() === '' ? undefined : e.target.value)}
                />
                <p className="p-ayuda">{puedeEditarCalendario(perfil) ? 'Los eventos solo llevan folio, nombre de pila, horario y un link al panel.' : 'Solo un administrador puede cambiar el calendario.'}</p>
                {errorDe("zoho_calendar_uid", "c-zoho")}
              </div>
            </fieldset>

            <div className="p-acciones">
              <button className="p-boton" type="submit" disabled={!editable || guardando || cambios.length === 0}>{guardando ? 'Guardando…' : 'Guardar nueva versión'}</button>
              <span>{cambios.length === 0 ? 'Sin cambios pendientes' : `${cambios.length} cambio(s) pendiente(s)`}</span>
            </div>
          </fieldset>
          <div aria-live="polite">{aviso && <p className={aviso.tipo === 'ok' ? 'p-ok' : 'p-error'}>{aviso.texto}</p>}</div>
        </form>

        <aside aria-label="Revisión de las reglas">
          {advertencias.length > 0 && (
            <section className="p-tarjeta" aria-labelledby="t-adv">
              <h2 id="t-adv">Advertencias</h2>
              <ul className="p-lista">{advertencias.map((a) => <li key={a.codigo}>{a.mensaje}</li>)}</ul>
            </section>
          )}
          <section className="p-tarjeta" aria-labelledby="t-cambios">
            <h2 id="t-cambios">Cambios pendientes</h2>
            {cambios.length === 0 ? <p>Ninguno.</p> : <ul className="p-lista p-diff">{cambios.map((c) => <li key={c.ruta}>{c.ruta}: {corto(c.antes)} → {corto(c.despues)}</li>)}</ul>}
          </section>
          <section className="p-tarjeta" aria-labelledby="t-previa">
            <h2 id="t-previa">Vista previa de horarios</h2>
            {validacion.ok === false ? <p className="p-error">Corrige las reglas para ver la vista previa.</p> : previa.length === 0 ? <p>Con estas reglas no hay horarios en los próximos días.</p> : (
              <>
                <p className="p-ayuda">Próximos días con agenda vacía · {previa[0]!.capacidad} persona(s) por horario · cupo {previa[0]!.cupo} al día · hora de {zona}.</p>
                <ul className="p-dias">
                  {previa.map((d) => (
                    <li key={d.fecha}>
                      <strong>{d.etiqueta}</strong> ({d.horas.length})
                      <span className="p-horas">{d.horas.map((h) => <span key={h}>{h}</span>)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section className="p-tarjeta" aria-labelledby="t-historial">
            <h2 id="t-historial">Historial de cambios</h2>
            {historial.length === 0 ? <p>Sin versiones guardadas.</p> : (
              <ol className="p-lista" reversed>
                {historial.map((h) => (
                  <li key={h.version}>
                    <strong>v{h.version}</strong> · {new Date(h.creado_en).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })} · {h.usuario_email ?? 'usuario eliminado'}
                    <details>
                      <summary>{h.diff.length} cambio(s)</summary>
                      <ul className="p-lista p-diff">{h.diff.slice(0, 50).map((c) => <li key={c.ruta}>{c.ruta}: {corto(c.antes)} → {corto(c.despues)}</li>)}</ul>
                    </details>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
