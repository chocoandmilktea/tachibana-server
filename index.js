var watcher = require("./watcher");

process.on("unhandledRejection", function (err) {
  console.error("[fatal] unhandledRejection:", err);
});

watcher.start();
