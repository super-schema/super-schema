@doc("A product in the catalog")
model Product {
  id: string;
  name: string;
  price?: decimal;
}

@doc("A category the products belong to")
model Category {
  id: string;
  label: string;
}
