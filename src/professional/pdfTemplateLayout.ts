import { rasterizeSvg } from './assets';
import { OperationControl } from './operation';
import { PdfNode, pdfTextWidth, preparePdfTypography, wrapPdfToken } from './pdfTypography';
import { SelectedPdfTemplate, pdfTemplateForm } from './pdfTemplate';

export function templateWidth(template: SelectedPdfTemplate | undefined, landscape: boolean): number {
  return (landscape ? 841.89 : 595.28) - (template?.style.left ?? 45) - (template?.style.right ?? 45);
}
function short(value: string, width: number, size = 8): string {
  if (pdfTextWidth(value, { fontSize: size }) <= width) return value;
  let result = '';
  for (const character of value) { if (pdfTextWidth(result + character + '…', { fontSize: size }) > width) break; result += character; }
  return result + '…';
}
/** Style existing archive furniture, without changing evidence text or state colors. */
function themeNodes(value: unknown, template: SelectedPdfTemplate): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) themeNodes(item, template); return; }
  const node = value as PdfNode, style = template.style;
  if (node.color === '#2458a6') node.color = node.link || node.linkToDestination ? style.linkColor : style.headingColor;
  if (node.color === '#172b42') node.color = style.textColor;
  for (const child of Object.values(node)) themeNodes(child, template);
}
/** A semantic layout adapter, not a second CSS/browser rendering engine. */
export async function applyPdfTemplate(definition: PdfNode & { content: PdfNode[] }, template: SelectedPdfTemplate | undefined, fallbackTitle: string, control?: OperationControl): Promise<PdfNode & { content: PdfNode[] }> {
  if (!template) return definition; // Preserve the pre-template Default path exactly.
  const { style: s, metadata: m } = template, title = m.title || fallbackTitle, width = templateWidth(template, false);
  let logo: string | undefined;
  // Sanitization and image decoding happen before any export publication.
  if (template.template.logoSvg) logo = await rasterizeSvg(template.template.logoSvg, 1000, control);
  const cover: PdfNode[] = [];
  if (template.template.cover) {
    if (logo) cover.push({ image: logo, fit: [113.39, 39.69], margin: [0, 0, 0, 40] });
    if (m.division) cover.push({ text: m.division, bold: true, fontSize: 10, margin: [0, 0, 0, 8] });
    const grouped = !!template.template.coverSections;
    cover.push({ text: wrapPdfToken(title, width, { fontSize: 20, bold: true }), fontSize: 20, bold: true, color: s.headingColor, margin: grouped ? [0, 12, 0, 6] : [0, 0, 0, 40] });
    if (grouped) cover.push({ canvas: [{ type: 'line', x1: 0, x2: width, y1: 0, y2: 0, lineWidth: 0.75, lineColor: s.headingColor }], margin: [0, 0, 0, 18] });
    const rows = pdfTemplateForm(template.template).sections.flatMap(section => section.fields.map(field => [field.label, m[field.key]] as [string, string | undefined]));
    const body = rows.filter((row): row is [string, string] => !!row[1]).map(([key, value]) => [{ text: key, bold: true }, { text: wrapPdfToken(value, width * 0.62 - 18, { fontSize: s.bodySize }) }]);
    const tableLayout = {
      hLineColor: () => s.borderColor, vLineColor: () => s.borderColor, hLineWidth: () => 0.5, vLineWidth: () => 0.5,
      paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6
    };
    if (grouped) for (const section of template.template.coverSections!) {
      const fields = section.fields.filter(field => section.showEmpty || m[field.key]);
      if (!fields.length) continue;
      cover.push({ text: section.title, fontSize: 13, bold: true, margin: [0, 0, 0, 6] },
        { table: { widths: [width * 0.38 - 17, width * 0.62 - 17], dontBreakRows: true, body: fields.map(field => [
          { text: field.label, bold: true }, { text: wrapPdfToken(m[field.key] || 'Not provided', width * 0.62 - 18, { fontSize: 10 }) }
        ]) }, layout: { ...tableLayout, hLineWidth: () => 0.75, vLineWidth: () => 0.75 }, fontSize: 10, lineHeight: 1, margin: [0, 0, 0, 14] });
    }
    else if (body.length) cover.push({ table: { widths: [width * 0.38 - 17, width * 0.62 - 17], body }, layout: tableLayout });
    // Editable metadata is descriptive, never a substitute for audit approvals.
    if (m.confidentiality) cover.push({ text: wrapPdfToken(m.confidentiality, width, { fontSize: 9 }), fontSize: 9, margin: [0, 18, 0, 0] });
    if (cover.length && s.coverTop !== s.top) {
      const first = cover[0], margin = Array.isArray(first.margin) ? [...first.margin as number[]] : [0, 0, 0, 0]; margin[1] += s.coverTop - s.top; first.margin = margin;
    }
    if (definition.content.length) definition.content[0] = { ...definition.content[0], pageBreak: 'before' };
  }
  themeNodes(definition.content, template);
  const furniture = (page: number, total: number, size: { width: number }, footer: boolean): PdfNode => {
    const available = size.width - s.left - s.right, left = available * 0.65 - 10, right = available * 0.35 - 10;
    const node: PdfNode = { margin: [s.left, footer ? 10 : 32, s.right, 0], fontSize: 8, color: '#444444', lineHeight: 1,
      stack: [
        ...(!footer ? [] : [{ canvas: [{ type: 'line', x1: 0, x2: available, y1: 0, y2: 0, lineWidth: 0.75, lineColor: s.borderColor }], margin: [0, 0, 0, 3] }]),
        { columns: [{ width: '65%', text: short(footer ? m.templateCode || template.template.label : m.division || '', left) }, { width: '35%', text: short(footer ? `${page} / ${total}` : m.project ? `Project: ${m.project}` : '', right), alignment: 'right' }], margin: [0, 0, 0, 3] },
        { columns: [{ width: '65%', text: short(footer ? [m.classification, m.confidentiality].filter(Boolean).join(' - ') : title, left) }, { width: '35%', text: short(footer ? title : [m.version, m.date ? `from ${m.date}` : ''].filter(Boolean).join(' '), right), alignment: 'right' }], margin: [0, 0, 0, 3] },
        ...(footer ? [] : [{ canvas: [{ type: 'line', x1: 0, x2: available, y1: 0, y2: 0, lineWidth: 0.75, lineColor: s.borderColor }] }])
      ] };
    preparePdfTypography(node); return node;
  };
  return { ...definition, content: [...cover, ...definition.content],
    info: { ...(definition.info as object), ...(m.title ? { title: m.title } : {}), keywords: `${(definition.info as { keywords?: string })?.keywords ?? ''}; omr-pdf-template/1 ${template.digest}` },
    defaultStyle: { font: 'Roboto', fontSize: s.bodySize, lineHeight: s.lineHeight, color: s.textColor }, pageMargins: [s.left, s.top, s.right, s.bottom],
    header: (page: number, total: number, size: { width: number }) => page === 1 && template.template.cover ? undefined : furniture(page, total, size, false),
    footer: (page: number, total: number, size: { width: number }) => furniture(page, total, size, true)
  };
}
