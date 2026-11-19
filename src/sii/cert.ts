import forge from "node-forge";

/*
 * El certificado digital del contribuyente viene en un archivo .pfx (PKCS#12)
 * protegido con clave. De ahí salen tres cosas: la clave privada con la que se firma,
 * el certificado que acompaña la firma, y el módulo y exponente que el SII pide
 * dentro del <KeyInfo>.
 *
 * El .pfx y su clave viven en Secret Manager. Nunca en Firestore, nunca en el
 * repositorio, nunca en un registro.
 */

export interface Certificado {
  /** Clave privada en PEM, para firmar. */
  privadaPem: string;
  /** Certificado en PEM. */
  certPem: string;
  /** El certificado en base64 sin cabeceras, que es como va en <X509Certificate>. */
  certB64: string;
  /** Módulo y exponente RSA en base64, para el <RSAKeyValue>. */
  modulo: string;
  exponente: string;
  /** RUT del titular, si viene en el certificado (el SII lo pone en serialNumber). */
  rut: string;
  /** Hasta cuándo sirve. Un certificado vencido hace que el SII rechace sin aviso. */
  vence: Date;
}

const sinCabeceras = (pem: string): string => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

/** Un entero de node-forge a base64 big-endian, como lo quiere XML-DSig. */
function enteroB64(n: forge.jsbn.BigInteger): string {
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex").toString("base64");
}

/**
 * Abre el .pfx y saca lo necesario para firmar.
 *
 * Lanza con un mensaje claro si la clave no corresponde: es el error más común al
 * cargar un certificado y conviene que se entienda a la primera.
 */
export function leerCertificado(pfx: Buffer, clave: string): Certificado {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString("binary")));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, clave);
  } catch {
    throw new Error("No se pudo abrir el certificado. Revisa que el archivo sea .pfx o .p12 y que la clave sea la correcta.");
  }

  const bolsaClave = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]
    || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  const bolsaCert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0];
  if (!bolsaClave?.key) throw new Error("El certificado no trae la clave privada.");
  if (!bolsaCert?.cert) throw new Error("El archivo no trae el certificado.");

  const llave = bolsaClave.key as forge.pki.rsa.PrivateKey;
  const cert = bolsaCert.cert;
  const certPem = forge.pki.certificateToPem(cert);

  // El SII guarda el RUT del titular en el serialNumber del sujeto.
  const sn = cert.subject.getField({ name: "serialNumber" })?.value
    || cert.subject.attributes.find((a) => a.type === "2.5.4.5")?.value || "";

  return {
    privadaPem: forge.pki.privateKeyToPem(llave),
    certPem,
    certB64: sinCabeceras(certPem),
    modulo: enteroB64(llave.n),
    exponente: enteroB64(llave.e),
    rut: String(sn).replace(/[^0-9kK-]/g, "").toUpperCase(),
    vence: cert.validity.notAfter,
  };
}

/** Días que le quedan al certificado. Negativo si ya venció. */
export const diasDeVida = (c: Certificado, ahora = Date.now()): number =>
  Math.floor((c.vence.getTime() - ahora) / 86400000);
