# Othekula — edição gratuita (GitHub Pages + Cloudflare Workers)

## O que esta versão faz
- Preserva o HTML/CSS e as animações da página original.
- Mantém os oito participantes e a validação dos números/PINs existentes no ficheiro original.
- Move validação, sessão e sorteio para um servidor Cloudflare Worker.
- Guarda os resultados numa base SQLite privada de um Durable Object.
- Serializa as operações de sorteio, impede que alguém tire a si próprio e impede destinatários repetidos.
- Não usa Firebase Cloud Functions, Firebase Blaze, D1 nem cartão bancário.

## Custos e limites
O projeto foi preparado para o plano gratuito Cloudflare Workers/Durable Objects. A documentação oficial indica 100.000 pedidos por dia para Workers Free e Durable Objects, além de limites diários de CPU e armazenamento. Ao atingir limites gratuitos, os pedidos podem falhar até ao reinício diário; não há promessa de serviço ilimitado. Consulte:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/

A página continua no GitHub Pages. O Firestore `othekula` deixa de ser usado nesta arquitetura; podes mantê-lo criado, mas não precisas publicar regras abertas nem ativar faturação Firebase.

## Conteúdo
- `public/index.html`: página original com lógica adaptada; só precisas de colocar a URL do Worker.
- `worker/index.js`: API e Durable Object.
- `worker/PARTICIPANTS_ENC.secret.txt`: valor secreto que deve ser copiado para o segredo Cloudflare. **Nunca publiques este ficheiro no GitHub.**
- `wrangler.toml`: configuração do Worker e do SQLite Durable Object.

## Parte A — criar o servidor gratuito
1. Cria/entra numa conta Cloudflare: https://dash.cloudflare.com/ . Escolhe o plano Free.
2. No painel, abre **Workers & Pages** e cria uma aplicação Worker. Também podes publicar pelo Wrangler se tiveres Node.js num computador.
3. Para publicar com Wrangler: instala Node.js e executa `npm install -g wrangler`.
4. Extrai este ZIP no computador, abre o terminal na pasta `othekula-gratis` e executa `wrangler login`.
5. Executa `wrangler secret put TOKEN_SECRET` e cola uma frase aleatória longa (pelo menos 32 caracteres). Guarda-a em local seguro; não a coloques no HTML nem no GitHub.
6. Abre `worker/PARTICIPANTS_ENC.secret.txt`, copia todo o conteúdo numa única linha. Executa `wrangler secret put PARTICIPANTS_ENC` e cola esse conteúdo. Este segredo contém os registos cifrados que estavam no HTML antigo; não o partilhes.
7. Executa `wrangler deploy` na pasta onde está `wrangler.toml`.
8. O terminal mostrará uma URL parecida com `https://othekula-api.<teu-subdominio>.workers.dev`. Copia-a.

Se não tiveres computador, podes usar o editor online do Cloudflare Workers para criar o Worker e configurar o binding Durable Object e os segredos no painel. A forma mais simples e fiel ao pacote é usar Wrangler num computador.

## Parte B — ligar o GitHub Pages
1. Abre `public/index.html` num editor.
2. Procura `const API_URL = "https://COLOCA-AQUI-O-NOME-DO-WORKER.workers.dev";`.
3. Substitui o endereço pelo URL real do Worker, mantendo as aspas.
4. Copia o ficheiro para a raiz do repositório GitHub Pages e chama-o `index.html`.
5. Faz commit e confirma em Settings > Pages que a branch/pasta correta está publicada.
6. Abre a página pelo endereço HTTPS `https://...github.io/...`.

## Teste recomendado
- Primeiro, entra com um número e PIN válidos de um dos participantes originais.
- Se já existir resultado para esse participante, deve aparecer sempre o mesmo.
- Se ainda não existir, deve aparecer a página de sorteio.
- Faz o sorteio uma única vez e confirma o resultado.
- Sai e volta a entrar: o mesmo resultado deve reaparecer.
- Não uses o botão de sorteio repetidamente em várias contas ao mesmo tempo durante o primeiro teste.

## Muito importante sobre os dados anteriores
Esta versão começa com uma base de sorteios nova no Cloudflare Durable Object. Ela **não importa automaticamente** os documentos que porventura existam nas coleções Firestore `draws`, `taken` e `done`. Se já houve sorteios reais no Firestore, não inicies novos sorteios nesta versão antes de o organizador confirmar e transferir os resultados; misturar bases pode causar atribuições repetidas.

## Segurança e limitações
- Os PINs são verificados no servidor. O navegador não recebe a lista cifrada.
- O token de sessão expira em 12 horas e fica apenas na memória do navegador; depois de fechar/recarregar a página, o participante volta a entrar.
- Há limite simples de tentativas por IP (10 em 15 minutos).
- A lista cifrada original usa PINs de quatro dígitos; por isso, o organizador deve manter os PINs privados e considerar substituí-los por códigos mais fortes numa futura versão.
- O código e o pacote foram preparados, mas não foram publicados nem testados na tua conta Cloudflare. A URL do Worker e os segredos precisam ser configurados por ti.
