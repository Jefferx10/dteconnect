-- Esquema de DTEConnect. Se ejecuta solo al arrancar; todo es idempotente.
--
-- Lo sensible —el .pfx, su clave y el XML de cada CAF— se guarda cifrado en
-- columnas bytea. La base nunca ve el contenido en claro: el cifrado y el
-- descifrado ocurren en la aplicación, con la llave maestra del entorno.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------- emisores

create table if not exists emisores (
  rut                text primary key,            -- 76086428-5, sin puntos
  razon              text        not null,
  giro               text        not null,
  acteco             integer,
  direccion          text        not null,
  comuna             text        not null,
  ciudad             text,
  resolucion_fecha   date        not null,
  resolucion_numero  integer     not null default 0,
  ambiente           text        not null default 'certificacion'
                       check (ambiente in ('certificacion', 'produccion')),
  activo             boolean     not null default false,

  cert_pfx           bytea,                       -- cifrado
  cert_clave         bytea,                       -- cifrada
  cert_titular       text,
  cert_vence         timestamptz,
  cert_subido        timestamptz,

  creado             timestamptz not null default now(),
  actualizado        timestamptz not null default now()
);

-- Las sucursales son del mismo RUT: no llevan certificado ni folios propios,
-- solo dirección y el código que el SII le dio a esa sucursal.
create table if not exists sucursales (
  id          bigserial primary key,
  emisor_rut  text    not null references emisores(rut) on delete cascade,
  nombre      text    not null,
  direccion   text    not null,
  comuna      text    not null,
  codigo_sii  text,
  activo      boolean not null default true,
  creado      timestamptz not null default now()
);
create index if not exists sucursales_emisor on sucursales (emisor_rut);

-- -------------------------------------------------------------------- CAF

create table if not exists cafs (
  id          bigserial primary key,
  emisor_rut  text    not null references emisores(rut) on delete cascade,
  tipo        integer not null,                   -- 33 factura, 39 boleta, ...
  desde       integer not null,
  hasta       integer not null,
  ultimo      integer not null,                   -- último folio entregado; desde-1 si ninguno
  xml         bytea   not null,                   -- el CAF completo, cifrado
  activo      boolean not null default true,
  creado      timestamptz not null default now(),
  constraint cafs_rango     check (hasta >= desde),
  constraint cafs_contador  check (ultimo >= desde - 1 and ultimo <= hasta)
);

-- Dos rangos del mismo emisor y tipo no pueden pisarse. Es la regla que el SII
-- no perdona —folios repetidos— y por eso se cuida en la base y no solo en el
-- código: así tampoco la rompe una carga hecha por otra vía.
do $$ begin
  alter table cafs add constraint cafs_sin_solape
    exclude using gist (
      emisor_rut with =,
      tipo with =,
      int4range(desde, hasta, '[]') with &&
    );
exception when duplicate_table or duplicate_object then null;
end $$;

create index if not exists cafs_disponibles on cafs (emisor_rut, tipo, desde)
  where activo and ultimo < hasta;

-- ----------------------------------------------------------------- folios

-- Cada folio entregado queda registrado antes de usarse. El SII exige poder
-- decir qué se hizo con cada uno, incluidos los que se perdieron.
create table if not exists folios (
  emisor_rut   text    not null,
  tipo         integer not null,
  folio        integer not null,
  caf_id       bigint  not null references cafs(id),
  estado       text    not null default 'asignado'
                 check (estado in ('asignado', 'emitido', 'anulado')),
  motivo       text,
  detalle      text,
  asignado     timestamptz not null default now(),
  actualizado  timestamptz,
  primary key (emisor_rut, tipo, folio)
);

-- ------------------------------------------------------------- documentos

create table if not exists documentos (
  id              bigserial primary key,
  emisor_rut      text    not null references emisores(rut),
  tipo            integer not null,
  folio           integer not null,
  fecha           date    not null,
  receptor_rut    text    not null,
  receptor_razon  text    not null,
  neto            integer not null default 0,
  exento          integer not null default 0,
  iva             integer not null default 0,
  total           integer not null,
  ambiente        text    not null,
  xml             bytea,                          -- el DTE firmado, tal como se envió
  track_id        text,
  estado          text    not null default 'creado'
                    check (estado in ('creado', 'enviado', 'aceptado',
                                      'aceptado_con_reparos', 'rechazado', 'error')),
  glosa           text,
  app             text,                           -- qué aplicación lo pidió
  idempotencia    text,                           -- para no emitir dos veces lo mismo
  creado          timestamptz not null default now(),
  actualizado     timestamptz not null default now(),
  unique (emisor_rut, tipo, folio)
);

-- Si una aplicación reintenta tras un corte de red, no debe quemar otro folio:
-- repite la misma clave de idempotencia y se le devuelve el documento anterior.
create unique index if not exists documentos_idempotencia
  on documentos (app, idempotencia) where idempotencia is not null;

create index if not exists documentos_pendientes on documentos (estado, actualizado)
  where estado = 'enviado';

-- ------------------------------------------------------- apps que consumen

create table if not exists apps (
  id           bigserial primary key,
  nombre       text    not null,
  llave_hash   text    not null unique,           -- sha256 de la llave; la llave no se guarda
  emisores     text[]  not null default '{}',     -- vacío = puede usar todos
  activo       boolean not null default true,
  creado       timestamptz not null default now(),
  ultimo_uso   timestamptz
);

-- ------------------------------------------------------------- bitácora

-- Qué pidió cada aplicación y cómo le fue. Sirve para la etapa de
-- "procedimientos auditables" que el SII pide declarar.
create table if not exists bitacora (
  id          bigserial primary key,
  app         text,
  emisor_rut  text,
  accion      text    not null,
  detalle     text,
  ok          boolean not null default true,
  t           timestamptz not null default now()
);
create index if not exists bitacora_tiempo on bitacora (t desc);
