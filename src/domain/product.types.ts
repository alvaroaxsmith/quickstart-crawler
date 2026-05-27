// Schema do produto extraído de uma URL do iFood (§4 do case.md).
// Os 7 campos são obrigatórios na saída. Não disponíveis → null (não omitir chave).
// Regra: status === 'success' SE E SOMENTE SE title !== null.

export interface Product {
  title: string | null
  normal_price: string | null
  discount_price: string | null
  product_url: string
  image_url: string | null
  status: 'success' | 'error'
  error_message: string | null
}

export function createSuccessProduct(input: {
  title: string
  normal_price: string | null
  discount_price: string | null
  product_url: string
  image_url: string | null
}): Product {
  return {
    title: input.title,
    normal_price: input.normal_price,
    discount_price: input.discount_price,
    product_url: input.product_url,
    image_url: input.image_url,
    status: 'success',
    error_message: null,
  }
}

export function createErrorProduct(input: {
  product_url: string
  error_message: string
}): Product {
  return {
    title: null,
    normal_price: null,
    discount_price: null,
    product_url: input.product_url,
    image_url: null,
    status: 'error',
    error_message: input.error_message,
  }
}
