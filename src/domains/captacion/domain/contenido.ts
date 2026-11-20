/**
 * Contenido de la landing por vacante (apps/web/vacantes/{slug}.json): textos, video y preguntas.
 * Cambiarlo requiere commit y build (§1 regla 5). Las reglas operativas (agenda, mensajes) NO van aquí.
 * Los textos admiten marcado mínimo: **negrita** (<strong>) y __énfasis__ (<b>); nunca HTML.
 */
import { z } from 'zod';
import { PreguntasSchema } from './formulario.ts';

const T = (max = 600) => z.string().min(1).max(max);
const Lineas = z.array(T(200)).min(1).max(6);
const Encabezado = { etiqueta: T(80), titulo: Lineas, intro: T(600).optional() };
const Tarjeta = z.strictObject({ indice: T(80), titulo: T(160), texto: T(800) });

export const ContenidoVacanteSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  version: z.number().int().positive(),
  seo: z.strictObject({ titulo: T(120), descripcion: T(300) }),
  menu_etiqueta: T(80),
  tracking: z.strictObject({ vacancy_id: T(80), client_id: T(80), content_category: T(80) }),
  zona_horaria: T(60),
  whatsapp: z.strictObject({ numero: z.string().regex(/^52\d{10}$/), etiqueta: T(40), atencion: T(120) }),
  barra_superior: z.strictObject({ insignia: T(40), texto: T(300) }),
  hero: z.strictObject({
    eyebrow: z.array(T(60)).min(1).max(4),
    titulo: Lineas,
    lead: T(800),
    pills: z.array(z.strictObject({ titulo: T(120), detalle: T(200) })).max(6),
    cta_primario: T(80),
    cta_secundario: T(80),
    stats: z.array(z.strictObject({ valor: T(30), detalle: T(160) })).max(6),
  }),
  video: z.strictObject({
    src: z.string().regex(/^\/[\w\-./]+\.(mp4|webm)$/),
    poster: z.string().regex(/^\/[\w\-./]+\.(webp|jpg|png)$/).optional(),
    etiqueta: T(120),
    presentador: z.strictObject({ titulo: T(120), subtitulo: T(120) }),
    leyenda: T(300),
    sticker: T(60),
  }),
  beneficios: z.strictObject({ ...Encabezado, tarjetas: z.array(Tarjeta).max(12), funcion: Tarjeta.optional() }),
  calculadora: z
    .strictObject({ titulo: T(120), base_mensual: z.number().nonnegative(), min: z.number().nonnegative(), max: z.number().positive(), paso: z.number().positive(), inicial: z.number().nonnegative(), semanas_por_mes: z.number().positive() })
    .refine((c) => c.min <= c.inicial && c.inicial <= c.max, 'inicial fuera de rango')
    .optional(),
  perfil: z.strictObject({
    ...Encabezado,
    columnas: z.array(z.strictObject({ tipo: z.enum(['si', 'no']), encabezado: T(80), nota: T(60), items: z.array(z.strictObject({ titulo: T(120), texto: T(400) })).max(12) })).max(2),
  }),
  ubicacion: z.strictObject({
    ...Encabezado,
    sitio: Tarjeta,
    direccion: T(200),
    mapa_embed: z.url({ protocol: /^https$/ }),
    mapa_link: z.url({ protocol: /^https$/ }),
    documentos: z.strictObject({ indice: T(80), titulo: T(120), intro: T(400), items: z.array(T(80)).max(20), nota: z.strictObject({ titulo: T(80), texto: T(400) }) }),
  }),
  postulacion: z.strictObject({ ...Encabezado, pasos: z.array(T(60)).min(1).max(5) }),
  formulario: z.strictObject({ preguntas: PreguntasSchema }),
  pase: z.strictObject({ vacante: T(160), atencion: T(120), direccion: T(240), documentos: z.array(T(120)).max(12) }),
  faq: z.strictObject({ ...Encabezado, items: z.array(z.strictObject({ pregunta: T(200), respuesta: T(1000) })).max(20) }),
  footer: z.strictObject({ leyenda: T(160), direccion: T(200) }),
  sticky: z.strictObject({ titulo: T(80), detalle: T(80), cta: T(40) }),
});

export type ContenidoVacante = z.output<typeof ContenidoVacanteSchema>;
