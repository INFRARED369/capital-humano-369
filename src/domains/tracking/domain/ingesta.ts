/** TRK-06 · Contrato estricto del cuerpo que el SDK envía a tracking-ingest. */
import { z } from 'zod';
import { EVENTOS_NAVEGADOR } from './eventos.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID);
const corto = (max: number) => z.string().trim().min(1).max(max);
const COOKIE_META = /^fb\.\d\.\d{10,16}\.[\w.-]{1,500}$/;

const AtribucionBase = {
  utm_source: corto(100).optional(),
  utm_medium: corto(100).optional(),
  utm_campaign: corto(150).optional(),
  utm_content: corto(150).optional(),
  utm_term: corto(150).optional(),
};

const AtribucionConConsentimiento = z.strictObject({
  ...AtribucionBase,
  fbclid: corto(500).optional(),
  gclid: corto(200).optional(),
  fbc: z.string().regex(COOKIE_META).max(600).optional(),
  fbp: z.string().regex(COOKIE_META).max(100).optional(),
});

/** Sin consentimiento solo viajan los UTM y la presencia (no el valor) de los click ids. */
const AtribucionAnonima = z.strictObject({
  ...AtribucionBase,
  tiene_fbclid: z.boolean().optional(),
  tiene_gclid: z.boolean().optional(),
});

const CustomData = z.strictObject({
  vacancy_id: z.string().regex(/^[\w-]{1,64}$/).optional(),
  client_id: uuid.optional(),
  content_category: z.string().regex(/^[\w -]{1,60}$/).optional(),
});

const Props = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.union([z.string().max(200), z.number().finite(), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 12, 'demasiadas propiedades');

const Comun = {
  v: z.literal(1),
  event_id: uuid,
  nombre: z.enum(EVENTOS_NAVEGADOR),
  pagina: z.string().regex(/^\/[\w\-./~%]*$/).max(300).optional(),
  custom_data: CustomData.optional(),
  props: Props.optional(),
};

export const EventoNavegadorSchema = z.discriminatedUnion('consentimiento', [
  z.strictObject({
    ...Comun,
    consentimiento: z.literal(true),
    visitor_id: uuid,
    referrer: z.string().max(1000).optional(),
    atribucion: AtribucionConConsentimiento.optional(),
  }),
  z.strictObject({
    ...Comun,
    consentimiento: z.literal(false),
    referrer: z.string().max(1000).optional(),
    atribucion: AtribucionAnonima.optional(),
  }),
]);

export type EventoNavegadorEntrada = z.infer<typeof EventoNavegadorSchema>;
export const TAMANO_MAXIMO_CUERPO = 8 * 1024;
