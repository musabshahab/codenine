declare const __CODENINE_BUSINESS_EDITION__: boolean;

require("./compileCache.cjs");
// A business build is only a window onto the company's Codenine.
require(__CODENINE_BUSINESS_EDITION__ ? "./businessMain.cjs" : "./main.cjs");
