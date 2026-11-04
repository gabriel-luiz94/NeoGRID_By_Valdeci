/* Web Worker do cálculo das pistas. */
importScripts('02-clipper.js', '03-ruas.js', '03b-ruas-core.js');

self.onmessage = async (evento) => {
  let ultimo = 0;
  const avisar = (texto, fracao) => {
    const agora = Date.now();
    if (agora - ultimo < 100) return;   // a tela não precisa de mais que 10 atualizações por segundo
    ultimo = agora;
    self.postMessage({prog: [texto, fracao]});
  };
  try {
    self.postMessage({fim: await calcRuasCore(evento.data, avisar)});
  } catch (erro) {
    self.postMessage({erro: erro && erro.message ? erro.message : String(erro)});
  }
};
