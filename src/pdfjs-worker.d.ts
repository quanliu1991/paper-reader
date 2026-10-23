// pdfjs worker 模块无类型声明（运行时注入 globalThis.pdfjsWorker 用）
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const src: string;
  export default src;
}
