// Both libraries register optional algorithms on their core objects.
import CryptoJS from 'crypto-js/core';
import 'crypto-js/aes';
import 'crypto-js/hmac';
import 'crypto-js/pad-zeropadding';
import 'crypto-js/sha1';
import 'crypto-js/sha256';
import forge from 'node-forge/lib/forge';
import 'node-forge/lib/x509';

export { CryptoJS, forge };
