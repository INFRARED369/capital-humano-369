/** /vacantes/{slug}/ (CAP-01): una página estática por cada apps/web/vacantes/*.json (NFR-ESC-06). */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import '../../../components/captacion/vacante.css';
import { LandingVacante } from '../../../components/captacion/vacante/LandingVacante';
import { listarVacantes, menuVacantes, obtenerVacante } from '../../../lib/captacion/contenido';

export const dynamicParams = false;

export function generateStaticParams() {
  return listarVacantes().map((v) => ({ slug: v.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const c = obtenerVacante((await params).slug);
  return c ? { title: c.seo.titulo, description: c.seo.descripcion } : {};
}

export default async function PaginaVacante({ params }: { params: Promise<{ slug: string }> }) {
  const c = obtenerVacante((await params).slug);
  if (!c) notFound();
  return <LandingVacante c={c} vacantes={menuVacantes()} />;
}
