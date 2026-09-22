# Finances API spec

## Flows 

WIP

## CRUD Endpoints

All of these slugs will be under `/v1/api`

### `/counterparty`

To create a counterparty under a user's name.

Verbs:

- `PUT`: to create a counterparty under a user's name.

```json
{
    "name": "some name", // mandatory
    "description": "some description" // mandatory
}
```

- `POST`: to update a counterpartie's data. You can update all, several, or all of the properties of the counterparty.

```jsonc
{
    "id": 1, // this is mandatory
    "name": "some name", // optional
    "description": "some description" // optional
}
```

- `GET`: to get a counterparty based on `name`, `description` or `id` (always limited by `owner_id = user_id` )

To get from `id`:
```jsonc
{
    "id": 1,
}
```

To search for names:
```jsonc
{
    "query": {
        "name": "Carlos" // fts search on the name field
    }
}
```
Or
```jsonc
{
    "name": "Carlos" // exact name matches
}
```

- `DELETE`: Only if no movements have a reference to the `counterparty` that is to be deleted.

Just must provide a JSON body with only the property `id` that tells the backend what `counterparty` to delete.
```jsonc
{
    "id": 1
}
```


### `/movement`

To register, read, update and delete a movement (expense, ingress, loan, etc) under a user's name

### `PUT /financial_instrument`

To register a new financial instrument (bank account, crypto exchange account) for an user




### Un usuario quiere registrar un gasto:

- Hay que registrar su instrumento financiero que seria from_instrument_id (financial_instruments)
- Esto implica que el `financial_provider` debe estar creado en `financial_providers`
- Debe estar creada la moneda indicada: supongamos VES
- Hay que crear el counterparty si no existe, de la lista de counterparties del usuario,
osea, WHERE owner_id = user_id

Entonces, el cliente que llame la API debe conocer:

- `id` del instrumento de `financial_instruments` (`WHERE owner_id = user_id`)
- `user_id` de `users`
- `currency_code` de `currencies`
- 



Crear columna llamada fp_friendly_name, varchar(15): Sera un nombre corto que tambien identifique al banco, como `mercantil`, `bbva`, `bdv`, `bnc`, `bancaribe`, etc. Este nombre en conjunto con el `country` (que tambien debe ser agregado) debe identificar de manera inequivoca al banco. O se deberia dejar solo el `fp_friendly_name` y a;adir un sufijo para bancos/proveedores que se llamen igual pero de otros paises, tipo `bbva_es`?


Estos tablas no seran llenadas por los agentes/clientes, solo leidas

- `financial_providers`
- `currencies`
- `conversion_rates`

Se debe modificar `conversion_rates` para que se puedan registrar varias tasas de conversion entre monedas
