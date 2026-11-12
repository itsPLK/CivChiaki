/* Direct eval puts the generated factory in the loader's local scope. */
if(typeof ChiakiCore!=="function")throw Error("Bundled Chiaki runtime is missing");
window.ChiakiCore=ChiakiCore;
