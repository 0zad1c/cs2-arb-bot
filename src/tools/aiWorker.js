import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';

const LM_STUDIO_URL = 'http://127.0.0.1:1234/v1/chat/completions';

async function main() {
  const args = process.argv.slice(2);
  const fileArgIndex = args.indexOf('--file');
  const actionArgIndex = args.indexOf('--action');
  const inplaceIndex = args.indexOf('--inplace');
  
  if (fileArgIndex === -1 || actionArgIndex === -1) {
    console.error(chalk.red('Error: Faltan argumentos.'));
    console.log(chalk.yellow('Uso esperado: npm run ai -- --file <ruta> --action <document|refactor|boilerplate> [--inplace]'));
    console.log(chalk.yellow('Ejemplo: npm run ai -- --file src/bot.js --action document'));
    process.exit(1);
  }

  const filePath = args[fileArgIndex + 1];
  const action = args[actionArgIndex + 1];
  const inplace = inplaceIndex !== -1;

  if (!filePath || !action) {
    console.error(chalk.red('Debes proveer un valor después de --file y --action.'));
    process.exit(1);
  }

  let codeContent = '';
  try {
    codeContent = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    console.error(chalk.red(`Error al leer el archivo ${filePath}:`), err.message);
    process.exit(1);
  }

  let systemPrompt = '';
  if (action === 'document') {
    systemPrompt = 'Eres un experto en NodeJS. Tu tarea es recibir código, analizarlo y agregar documentación detallada (JSDoc) explicando la funcion de cada bloque clave, entradas y salidas. Retorna ÚNICAMENTE EL CÓDIGO documentado. NO agregues introducciones, conclusiones ni explicaciones fuera del código. Asegúrate de no incluir las etiquetas de formato (```javascript), simplemente el texto en plano listo para guardar en el archivo.';
  } else if (action === 'refactor') {
    systemPrompt = 'Eres un ingeniero Senior en NodeJS. Tu tarea es recibir código y refactorizarlo basándote en Clean Code. Mejora la legibilidad, separa lógica redundante y optimiza procesos. Retorna ÚNICAMENTE EL CÓDIGO refactorizado. NO agregues introducciones, conclusiones ni explicaciones. Solo el código fuente final, listo para guardar en archivo.';
  } else if (action === 'boilerplate') {
    systemPrompt = 'Eres un desarrollador experto. Tu tarea es leer las descripciones que te enviarán y generar sólamente el esqueleto/código asíncrono (boilerplate) funcional y escalable en NodeJS correspondiente a las exigencias. Retorna ÚNICAMENTE EL CÓDIGO final sin formato markdown, ni texto introductorio.';
  } else {
    console.error(chalk.red(`Acción desconocida '${action}'. Usos permitidos: document, refactor, boilerplate.`));
    process.exit(1);
  }

  console.log(chalk.blue(`Iniciando tarea de [${action}] mediante LM Studio...`));
  console.log(chalk.gray(`-> Archivo: ${filePath}`));
  console.log(chalk.gray(`-> Intentando conectar a: ${LM_STUDIO_URL}`));

  try {
    const response = await axios.post(LM_STUDIO_URL, {
      model: 'local-model', // LM Studio suele ignorar este string, pero requiere que exista
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Contenido a procesar:\n\n${codeContent}` }
      ],
      temperature: 0.2, // Favorece resultados estables, menos creativos y enfocados a código
      stream: false
    });

    let resultMsg = response.data.choices[0].message.content;

    // Limpiar artefactos comunes en los outputs de LLM (comillas triples que a veces se escapan)
    resultMsg = resultMsg.replace(/^```(?:javascript|js)?\n/i, '');
    resultMsg = resultMsg.replace(/```$/g, '');

    const ext = path.extname(filePath);
    const basename = path.basename(filePath, ext);
    const dir = path.dirname(filePath);

    // Por defecto, se crea un sufijo para no romper nada, ej: bot.document.js
    let outputPath = filePath;
    if (!inplace) {
      outputPath = path.join(dir, `${basename}.${action}${ext}`);
    }

    await fs.writeFile(outputPath, resultMsg.trim(), 'utf-8');
    console.log(chalk.green(`¡Éxito! El código procesado ha sido guardado en: ${outputPath}`));

    if (!inplace) {
      console.log(chalk.yellow(`(⚠️ Puedes usar --inplace la próxima vez para sobrescribir directamente tu archivo actual)`));
    }

  } catch (err) {
    console.error(chalk.red('\n[!] Error crítico al ejecutar o comunicar con LM Studio.'));
    if (err.code === 'ECONNREFUSED') {
      console.log(chalk.red(`No se pudo conectar a ${LM_STUDIO_URL}.`));
      console.log(chalk.yellow('Solución:'));
      console.log(chalk.yellow('1. Abre LM Studio.'));
      console.log(chalk.yellow('2. Ve a la pestaña de "Local Server" (el ícono de las dos flechas).'));
      console.log(chalk.yellow('3. Selecciona un modelo y presiona "Start Server".'));
    } else if (err.response) {
      console.error(chalk.red(`Causa: `), err.response.data || err.response.statusText);
    } else {
      console.error(err.message);
    }
  }
}

main();
