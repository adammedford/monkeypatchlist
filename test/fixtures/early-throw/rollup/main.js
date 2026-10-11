if (typeof global === "undefined") throw new Error("needs global");
global.fetch = function w() { return 1 };
