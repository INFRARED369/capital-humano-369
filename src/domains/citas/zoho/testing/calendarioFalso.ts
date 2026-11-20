/**
 * Doble de prueba de CalendarioExternoPort: un "Zoho" en memoria con etags,
 * inyección de fallas y manipulación manual (para simular a un reclutador editando en Zoho).
 * Solo para pruebas; no se exporta en index.ts.
 */
import { err, ok, type Result } from '@shared/result.ts';
import type { CalendarioExternoPort, RangoFechas } from '../application/puertos.ts';
import type { EventoCalendario } from '../domain/evento.ts';
import { extraerUidPropio } from '../domain/evento.ts';
import type { ErrorCalendario, EventoRemoto } from '../domain/tipos.ts';

export class CalendarioFalso implements CalendarioExternoPort {
  readonly calendarios = new Map<string, Map<string, EventoRemoto>>();
  readonly llamadas: string[] = [];
  /** Fallas a devolver en las próximas llamadas (FIFO), por operación o en cualquiera ('*'). */
  private fallas: Array<{ op: string; error: ErrorCalendario }> = [];
  private seq = 0;

  fallarProximas(n: number, error: ErrorCalendario, op = '*'): void {
    for (let i = 0; i < n; i++) this.fallas.push({ op, error });
  }

  eventos(cal: string): EventoRemoto[] {
    return [...(this.calendarios.get(cal)?.values() ?? [])];
  }

  /** Simula un borrado manual en Zoho. */
  borrarAMano(cal: string, uid: string): void {
    this.calendarios.get(cal)?.delete(uid);
  }

  /** Simula una edición manual en Zoho. */
  editarAMano(cal: string, uid: string, cambios: Partial<EventoRemoto>): void {
    const e = this.calendarios.get(cal)?.get(uid);
    if (e) this.calendarios.get(cal)!.set(uid, { ...e, ...cambios, etag: String(Number(e.etag) + 1) });
  }

  /** Inserta un evento directamente (p. ej. uno creado antes de una caída del worker). */
  sembrar(cal: string, e: EventoCalendario): EventoRemoto {
    return this.guardar(cal, `zoho-${++this.seq}`, e, '1');
  }

  private falla(op: string): ErrorCalendario | null {
    const i = this.fallas.findIndex((f) => f.op === op || f.op === '*');
    return i === -1 ? null : this.fallas.splice(i, 1)[0]!.error;
  }

  private cal(uid: string): Map<string, EventoRemoto> {
    let c = this.calendarios.get(uid);
    if (!c) this.calendarios.set(uid, (c = new Map()));
    return c;
  }

  private guardar(cal: string, uid: string, e: EventoCalendario, etag: string): EventoRemoto {
    const r: EventoRemoto = { uid, etag, titulo: e.titulo, descripcion: e.descripcion, inicio: e.inicio, fin: e.fin, uidPropio: extraerUidPropio(e.descripcion), numAsistentes: 0 };
    this.cal(cal).set(uid, r);
    return r;
  }

  async crear(cal: string, e: EventoCalendario): Promise<Result<EventoRemoto, ErrorCalendario>> {
    this.llamadas.push('crear');
    const f = this.falla('crear');
    return f ? err(f) : ok(this.guardar(cal, `zoho-${++this.seq}`, e, '1'));
  }

  async actualizar(cal: string, uid: string, etag: string, e: EventoCalendario): Promise<Result<EventoRemoto, ErrorCalendario>> {
    this.llamadas.push('actualizar');
    const f = this.falla('actualizar');
    if (f) return err(f);
    const actual = this.cal(cal).get(uid);
    if (!actual) return err({ tipo: 'no_encontrado', status: 404, mensaje: 'no existe' });
    if (actual.etag !== etag) return err({ tipo: 'conflicto', status: 412, mensaje: 'etag' });
    return ok(this.guardar(cal, uid, e, String(Number(etag) + 1)));
  }

  async borrar(cal: string, uid: string, etag: string): Promise<Result<void, ErrorCalendario>> {
    this.llamadas.push('borrar');
    const f = this.falla('borrar');
    if (f) return err(f);
    const actual = this.cal(cal).get(uid);
    if (actual && actual.etag !== etag) return err({ tipo: 'conflicto', status: 412, mensaje: 'etag' });
    this.cal(cal).delete(uid);
    return ok(undefined);
  }

  async obtener(cal: string, uid: string): Promise<Result<EventoRemoto | null, ErrorCalendario>> {
    this.llamadas.push('obtener');
    const f = this.falla('obtener');
    return f ? err(f) : ok(this.cal(cal).get(uid) ?? null);
  }

  async listar(cal: string, rango: RangoFechas): Promise<Result<EventoRemoto[], ErrorCalendario>> {
    this.llamadas.push('listar');
    const f = this.falla('listar');
    if (f) return err(f);
    const d = Date.parse(rango.desde);
    const h = Date.parse(rango.hasta);
    return ok(this.eventos(cal).filter((e) => Date.parse(e.fin) > d && Date.parse(e.inicio) < h));
  }
}
