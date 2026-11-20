/**
 * Acceso a datos del panel con supabase-js (anon key + sesión del usuario). Toda lectura pasa por el RLS
 * (S1/DSH-06) y toda escritura por funciones security definer (S3):
 *  - shared.usuarios_roles / usuarios_vacantes / vacantes / clientes (lectura propia, RLS)
 *  - config.vacantes_reglas (vigente) y config.historial_reglas(...) (auditoría, S4)
 *  - citas.citas (agenda, RLS) + captacion.leads (solo folio y nombre de pila, RLS) — DSH-05
 *  - citas.registrar_asistencia(...) (CIT-10; publica AsistenciaRegistrada → CAPI offline, T6)
 *  - dashboard.api_kpis_diarios / api_funnel (DSH-01..03)
 *  - edge function panel-reglas (guardar reglas y altas, validación Zod en el servidor)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { FiltroNormalizado, FuenteDashboard, FilaFunnel, FilaKpi } from '../../../../src/domains/dashboard';
import type { Cambio } from '../../../../src/domains/vacantes';
import { configPublica } from '../config';
import type { FilaCita, FilaLead } from './agenda';
import { crearClienteFunciones } from './funciones';
import { resumirPerfil, type Perfil } from './roles';

export interface Vacante { id: string; cliente_id: string; slug: string; codigo: string; nombre: string; activa: boolean; agenda_modo: string }
export interface Cliente { id: string; nombre: string }
export interface VersionReglas { version: number; reglas: unknown; creado_en: string }
export interface EntradaHistorial { version: number; usuario_email: string | null; creado_en: string; diff: Cambio[] }

let cliente: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  cliente ??= createClient(configPublica.supabaseUrl, configPublica.supabaseAnonKey || 'sin-configurar', {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: '369-panel-auth' },
  });
  return cliente;
}

function lanzar(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export function crearApiPanel(sb: SupabaseClient = supabase()) {
  const funciones = crearClienteFunciones(configPublica.funcionesUrl, (i, init) => fetch(i, init), async () => (await sb.auth.getSession()).data.session?.access_token ?? null);

  return {
    funciones,

    async perfil(): Promise<Perfil | null> {
      const { data } = await sb.auth.getUser();
      const u = data.user;
      if (!u) return null;
      const [roles, asignaciones] = await Promise.all([
        sb.schema('shared').from('usuarios_roles').select('rol').eq('user_id', u.id),
        sb.schema('shared').from('usuarios_vacantes').select('vacante_id').eq('user_id', u.id),
      ]);
      lanzar(roles.error);
      lanzar(asignaciones.error);
      return resumirPerfil(u.id, u.email ?? '', roles.data ?? [], asignaciones.data ?? []);
    },

    async vacantes(): Promise<{ vacantes: Vacante[]; clientes: Cliente[] }> {
      const [v, c] = await Promise.all([
        sb.schema('shared').from('vacantes').select('id, cliente_id, slug, codigo, nombre, activa, agenda_modo').order('nombre'),
        sb.schema('shared').from('clientes').select('id, nombre').order('nombre'),
      ]);
      lanzar(v.error);
      lanzar(c.error);
      return { vacantes: (v.data ?? []) as Vacante[], clientes: (c.data ?? []) as Cliente[] };
    },

    async reglasVigentes(vacanteId: string): Promise<VersionReglas | null> {
      const { data, error } = await sb.schema('config').from('vacantes_reglas').select('version, reglas, creado_en').eq('vacante_id', vacanteId).order('version', { ascending: false }).limit(1);
      lanzar(error);
      return (data?.[0] as VersionReglas | undefined) ?? null;
    },

    async historial(vacanteId: string): Promise<EntradaHistorial[]> {
      const { data, error } = await sb.schema('config').rpc('historial_reglas', { p_vacante: vacanteId, p_limite: 50 });
      lanzar(error);
      return (data ?? []) as EntradaHistorial[];
    },

    async agenda(fecha: string, vacanteId?: string): Promise<{ citas: FilaCita[]; leads: FilaLead[] }> {
      let q = sb.schema('citas').from('citas').select('id, vacante_id, inicio, fin, estado, asistio, evaluacion, lead_id').eq('dia_local', fecha).neq('estado', 'expirada').order('inicio');
      if (vacanteId) q = q.eq('vacante_id', vacanteId);
      const { data, error } = await q;
      lanzar(error);
      const citas = (data ?? []) as FilaCita[];
      return { citas, leads: await this.leads(citas) };
    },

    async cita(id: string): Promise<{ cita: FilaCita | null; leads: FilaLead[] }> {
      const { data, error } = await sb.schema('citas').from('citas').select('id, vacante_id, inicio, fin, estado, asistio, evaluacion, lead_id').eq('id', id).limit(1);
      lanzar(error);
      const citas = (data ?? []) as FilaCita[];
      return { cita: citas[0] ?? null, leads: await this.leads(citas) };
    },

    /** Minimización: solo folio y nombre de pila (nunca teléfono ni correo). */
    async leads(citas: readonly FilaCita[]): Promise<FilaLead[]> {
      const ids = [...new Set(citas.map((c) => c.lead_id).filter((x): x is string => !!x))];
      if (ids.length === 0) return [];
      const { data, error } = await sb.schema('captacion').from('leads').select('id, folio, nombre_pila').in('id', ids);
      lanzar(error);
      return (data ?? []) as FilaLead[];
    },

    async registrarAsistencia(citaId: string, asistio: boolean, evaluacion: Record<string, unknown> | null): Promise<{ estado: string }> {
      const { data, error } = await sb.schema('citas').rpc('registrar_asistencia', { p_cita: citaId, p_asistio: asistio, p_evaluacion: evaluacion });
      lanzar(error);
      return data as { estado: string };
    },

    /** Estado de contratación de la cita (sin lead_id). */
    async contratacion(citaId: string): Promise<{ contratado_en: string; entregado_en: string | null } | null> {
      const { data, error } = await sb.schema('dashboard').from('contrataciones').select('contratado_en, entregado_en').eq('cita_id', citaId).limit(1);
      lanzar(error);
      return (data?.[0] as { contratado_en: string; entregado_en: string | null } | undefined) ?? null;
    },

    /** Contratado / expediente entregado → publica LeadContratado (privacidad y CAPI offline). */
    async registrarContratacion(citaId: string, entregado: boolean): Promise<{ estado: string }> {
      const { data, error } = await sb.schema('dashboard').rpc('registrar_contratacion', { p_cita: citaId, p_entregado: entregado });
      lanzar(error);
      return data as { estado: string };
    },

    fuenteDashboard(): FuenteDashboard {
      const rango = async <T,>(tabla: string, columnas: string, f: FiltroNormalizado): Promise<T[]> => {
        let q = sb.schema('dashboard').from(tabla).select(columnas).gte('dia', f.desde).lte('dia', f.hasta).limit(5000);
        if (f.vacanteId) q = q.eq('vacante_id', f.vacanteId);
        const { data, error } = await q;
        lanzar(error);
        return (data ?? []) as unknown as T[];
      };
      return {
        kpis: (f) => rango<FilaKpi>('api_kpis_diarios', '*', f),
        funnel: (f) => rango<FilaFunnel>('api_funnel', 'dia, vacante_id, cliente_id, campana, origen, evento, eventos', f),
      };
    },
  };
}

export type ApiPanel = ReturnType<typeof crearApiPanel>;
