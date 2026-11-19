import { SignedXml } from "xml-crypto";
import { Certificado } from "./cert";

/*
 * Firma XML-DSig como la pide el SII: enveloped, canonicalización C14N exclusiva,
 * SHA1 para el digest y RSA-SHA1 para la firma. El SII todavía no acepta SHA256 acá,
 * aunque en todo lo demás esté desaconsejado.
 *
 * El <KeyInfo> lleva el módulo y el exponente además del certificado. Varios
 * validadores del SII lo exigen, así que se arma a mano en vez de dejar el que
 * genera la librería.
 */

const C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";
const RSA_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

/**
 * Firma el elemento `id` dentro de `xml` y deja la <Signature> al final de `padre`.
 *
 * - `id` es el valor del atributo ID del elemento firmado (el <Documento>, el
 *   <SetDTE> del sobre). La referencia queda como URI="#id".
 * - `padre` es el nombre local del elemento donde cuelga la firma: "DTE" para un
 *   documento, "EnvioDTE" para el sobre.
 */
export function firmarXml(xml: string, id: string, padre: string, cert: Certificado): string {
  const sig = new SignedXml({
    privateKey: cert.privadaPem,
    signatureAlgorithm: RSA_SHA1,
    canonicalizationAlgorithm: C14N,
    getKeyInfoContent: () =>
      "<KeyValue><RSAKeyValue>"
      + `<Modulus>${cert.modulo}</Modulus><Exponent>${cert.exponente}</Exponent>`
      + "</RSAKeyValue></KeyValue>"
      + `<X509Data><X509Certificate>${cert.certB64}</X509Certificate></X509Data>`,
  });

  sig.addReference({
    xpath: `//*[@ID='${id}']`,
    uri: `#${id}`,
    digestAlgorithm: SHA1,
    transforms: [ENVELOPED, C14N],
  });

  sig.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='${padre}']`, action: "append" },
  });

  return sig.getSignedXml();
}

/**
 * Firma la semilla para pedir el token de acceso al SII. Es un XML chico y sin ID,
 * así que la referencia va a la raíz con URI vacía.
 */
export function firmarSemilla(semilla: string, cert: Certificado): string {
  const xml = `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;
  const sig = new SignedXml({
    privateKey: cert.privadaPem,
    signatureAlgorithm: RSA_SHA1,
    canonicalizationAlgorithm: C14N,
    getKeyInfoContent: () =>
      "<KeyValue><RSAKeyValue>"
      + `<Modulus>${cert.modulo}</Modulus><Exponent>${cert.exponente}</Exponent>`
      + "</RSAKeyValue></KeyValue>"
      + `<X509Data><X509Certificate>${cert.certB64}</X509Certificate></X509Data>`,
  });
  sig.addReference({ xpath: "//*[local-name(.)='getToken']", uri: "", digestAlgorithm: SHA1, transforms: [ENVELOPED, C14N] });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='getToken']", action: "append" } });
  return sig.getSignedXml();
}

/** Verifica una firma con el certificado que viene dentro del propio XML. */
export function firmaValida(xml: string, certPem: string): boolean {
  const sig = new SignedXml({ publicCert: certPem });
  const nodo = xml.match(/<Signature[\s\S]*?<\/Signature>/)?.[0];
  if (!nodo) return false;
  sig.loadSignature(nodo);
  return sig.checkSignature(xml);
}
