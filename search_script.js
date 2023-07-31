const fs = require("fs").promises;
const { match } = require("assert");
const path = require("path");
const { Worker, isMainThread, parentPort } = require("worker_threads");

async function searchStringsInFile(filePath, searchStrings) {
  const matchedStrings = [];
  const content = await fs.readFile(filePath, "utf8");
  searchStrings.map((searchString) => content.includes(searchString) && matchedStrings.push(searchString));
  return matchedStrings;
}

async function findStringsInFiles(filePaths, searchStrings) {
  const matchingFiles = [];
  for (const filePath of filePaths) {
    const matched = await searchStringsInFile(filePath, searchStrings);
    if (matched.length > 0) {
      matchingFiles.push({ filePath, matched });
    }
  }
  return matchingFiles;
}

async function findStringsInDirectory(rootDirectory, searchStrings, excludedDirs) {
  const matchingFiles = [];
  let numFilesSearched = 0;
  let numDirsSearched = 0;

  async function traverseDir(currentDir) {
    try {
      const topStat = await fs.stat(currentDir);
      if (!topStat.isDirectory()) {
        numFilesSearched++;
        console.error(`Error while traversing file as directory: ${currentDir}\n`);
        const filePath = currentDir;
        const matched = await searchStringsInFile(filePath, searchStrings);
        if (matched.length > 0) {
          matchingFiles.push({ filePath, matched });
        }
        return;
      }
      const files = await fs.readdir(currentDir);

      for (const file of files) {
        const filePath = path.join(currentDir, file);
        const stat = await fs.stat(filePath);

        if (stat.isDirectory()) {
          numDirsSearched++;
          if (!excludedDirs.includes(file)) {
            await traverseDir(filePath);
          }
        } else {
          numFilesSearched++;
          const matched = await searchStringsInFile(filePath, searchStrings);
          if (matched.length > 0) {
            matchingFiles.push({ filePath, matched });
          }
        }
      }
    } catch (error) {
      console.error(`Error while traversing directory: ${currentDir}\n`, error);
    }
  }

  await traverseDir(rootDirectory);
  return { matchingFiles, numFilesSearched, numDirsSearched };
}

async function getSearchStrings() {
  const searchStrings = [];
  const searchStringsFile = "./search_fields.txt";
  const data = await fs.readFile(searchStringsFile, "utf8").catch((err) => {
    console.error("Error while reading search strings file", err);
    process.exit(1);
  });
  console.log("data loaded", data.length);
  data.split("\n").map((line) => {
    if (line.trim().length > 0) {
      searchStrings.push(line.trim());
    }
  });
  console.log("loaded search strings", searchStrings.length);
  return searchStrings;
}

function main() {
  let searchStrings = [];
  const excludedDirs = ["node_modules", ".git", ".idea", ".vscode", "build"];

  if (isMainThread) {
    const args = process.argv.slice(2);
    if (args.length < 1) {
      console.log("Usage: node search_script.js <search_directory>");
      process.exit(1);
    }

    const rootDirectory = args[0];
    // Main thread
    const numCores = 4;
    const workerPool = {};
    const statusInterval = 1000; // Update status every 1 second
    let totalFilesSearched = 0;
    let totalDirsSearched = 0;
    let matches = [];
    let callbacks = 0;

    function workerCallback(workerResult) {
      callbacks++;
      if (workerResult.finished) {
        console.log(`Worker ${workerResult.worker} finished`);
        delete workerPool[workerResult.worker];
      }
      if (workerResult.error) {
        console.error(workerResult.error);
      } else {
        totalFilesSearched += workerResult.numFilesSearched ?? 0;
        totalDirsSearched += workerResult.numDirsSearched ?? 0;
      }
      matches.push(...(workerResult.matchingFiles?.filter((a) => a !== null) ?? []));
      displayStatus();
    }

    function displayStatus() {
      console.log(`Wrks: ${Object.values(workerPool).length}, cbs: ${callbacks}
DIRs: ${totalDirsSearched}, Files: ${totalFilesSearched}, matches: ${matches.length}
`);

      checkAndFinish();
    }

    async function checkAndFinish() {
      // check finished
      if (Object.values(workerPool).length === 0) {
        console.log(`Total Files Searched: ${totalFilesSearched}`);
        console.log(`Total Dirs Searched: ${totalDirsSearched}`);
        console.log(`Total Matching Files: ${matches.length}`);
        terminateAllWorkers();

        if (matches.length === 0) {
          console.log("No matches found");
        } else {
          // append to the json results file
          const repo = rootDirectory.split("/").at(-1);
          let results = await fs.readFile("./search_results.json", "utf8");
          results = JSON.parse(results);
          results[repo] = matches;
          await fs.writeFile("./search_results.json", JSON.stringify(results, null, 2)).catch((err) => {
            console.error("Error while writing to results file", err);
            console.timeEnd("main.process");
            console.log(JSON.stringify(matches, null, 2));
            process.exit(1);
          });
          console.log("Results written to results.json for " + repo);
        }
        console.timeEnd("main.process");
        process.exit(0);
      }
    }

    function terminateAllWorkers() {
      for (const worker of Object.values(workerPool)) {
        worker.terminate();
      }
    }

    process.on("SIGINT", () => {
      terminateAllWorkers();
      process.exit(1);
    });

    (async () => {
      try {
        const files = await fs.readdir(rootDirectory, { withFileTypes: true });
        const chunks = [];
        const chunkSize = Math.ceil(files.length / numCores);
        for (let i = 0; i < files.length; i += chunkSize) {
          chunks.push(files.slice(i, i + chunkSize));
        }
        console.log(`Chunked ${files.length} root files into ${chunks.length} chunks of size ${chunkSize}`);

        for (let i = 0; i < numCores; i++) {
          console.log(`Starting Worker ${i}`);
          const worker = new Worker(__filename, {
            workerData: {
              files: chunks[i].map((f) => ({
                basePath: path.join(rootDirectory, f.name),
                isFile: f.isFile(),
                isDirectory: f.isDirectory(),
                name: f.name,
              })),
              searchStrings,
              excludedDirs,
              id: i + "-worker",
            },
          });
          workerPool[i + "-worker"] = worker;
          worker.on("message", workerCallback);
          worker.on("exit", () => {
            workerCallback({ worker });
          });
        }

        // Display status periodically
        setInterval(displayStatus, statusInterval);
      } catch (error) {
        console.error("Error while reading directory:", error);
      }
    })();
  } else {
    // Worker thread
    const { files, excludedDirs, id } = require("worker_threads").workerData;
    getSearchStrings().then((searchStrings) => {
      let topLevelFiles = [];
      let promises = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.isFile) {
          topLevelFiles.push(file.basePath);
        } else if (file.isDirectory && !excludedDirs.includes(file.name)) {
          promises.push(findStringsInDirectory(file.basePath, searchStrings, excludedDirs));
        }
      }
      promises.push(findStringsInFiles(topLevelFiles, searchStrings));
      Promise.allSettled(promises)
        .then((results) => {
          const matchingFiles = [];
          let numFilesSearched = 0;
          let numDirsSearched = 0;
          for (const result of results) {
            if (result.status === "fulfilled") {
              if (result.value.matchingFiles) {
                matchingFiles.push(...result.value.matchingFiles);
                numFilesSearched += result.value.numFilesSearched ?? 0;
                numDirsSearched += result.value.numDirsSearched ?? 0;
              } else {
                matchingFiles.push(...result.value);
              }
            } else {
              console.error(result.reason);
            }
          }
          parentPort.postMessage({ worker: id, matchingFiles, numFilesSearched, numDirsSearched, finished: true });
        })
        .catch((error) => {
          parentPort.postMessage({ worker: id, error, finished: true });
        });
    });
  }
}

console.time("main.process");
main();
